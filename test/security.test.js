import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { config as baseConfig } from '../src/config.js';
import { buildRuntime } from '../src/index.js';
import { createApp } from '../src/server.js';
import { clientIp, RateLimiter } from '../src/http/hardening.js';
import { safeParseJSON } from '../src/rankings/ranking-engine.js';

// The app is built with the real alert pipeline but no live sources and a
// stubbed ranking engine, so the suite never touches the Oref API.
const silentLogger = pino({ level: 'silent' });
let server;
let app;
let bus;
let baseUrl;
let dataDir;

class StubRankingEngine extends EventEmitter {
  constructor() {
    super();
    this.cache = null;
  }

  isFresh() {
    return false;
  }

  ensureQueryRunning() {}

  async get() {
    return { most: [], least: [], allCities: [], totalAlerts: 0, totalCities: 0 };
  }
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oref-test-'));
  const config = Object.freeze({
    ...baseConfig,
    dataDir,
    enableTzevaAdom: false,
    enablePushy: false,
    enableRankings: false,
    enableTestEndpoint: false,
  });

  const runtime = await buildRuntime({ config, logger: silentLogger });
  bus = runtime.bus;
  app = createApp({ ...runtime, rankingEngine: new StubRankingEngine() });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  app.locals.rateLimiter.stop();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

function resetLimits() {
  app.locals.rateLimiter.reset();
}

// ── Route surface ───────────────────────────────────────────────────────

test('1. Unknown routes 404 and traversal attempts do not escape the public dir', async () => {
  resetLimits();
  assert.strictEqual((await fetch(`${baseUrl}/valid-does-not-exist`)).status, 404);
  assert.strictEqual((await fetch(`${baseUrl}/../etc/passwd`)).status, 404);
  assert.strictEqual((await fetch(`${baseUrl}/../../package.json`)).status, 404);

  assert.strictEqual((await fetch(`${baseUrl}/`)).status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/index.html`)).status, 200);
  assert.strictEqual((await fetch(`${baseUrl}/live`)).status, 200);
});

test('2. Security headers are present on every response', async () => {
  resetLimits();
  for (const route of ['/', '/api/v1/state', '/does-not-exist']) {
    const res = await fetch(`${baseUrl}${route}`);
    await res.text();
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff', route);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY', route);
    assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', route);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, route);
    // frame-ancestors overrides X-Frame-Options where supported, so both must deny.
    assert.ok(csp.includes("frame-ancestors 'none'"), `${route}: ${csp}`);
  }
});

test('3. The dashboard runs without inline script, matching the CSP', async () => {
  resetLimits();
  const res = await fetch(`${baseUrl}/`);
  const html = await res.text();
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'"), `CSP must not allow inline script: ${csp}`);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html),
    'index.html must not contain an inline <script> body');
});

test('4. Error responses do not leak internals', async () => {
  resetLimits();
  const res = await fetch(`${baseUrl}/api/v1/geojson`);
  const text = await res.text();
  assert.ok(!text.includes('ReferenceError') && !text.includes('TypeError'));
  assert.ok(!text.includes(process.cwd()));
});

// ── Upstream response validation ────────────────────────────────────────

test('5. safeParseJSON rejects prototype pollution payloads', () => {
  const parsed = safeParseJSON(`[{"__proto__": {"polluted": "yes"}, "city": "Test"}]`);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(parsed.length, 0);
});

test('6. safeParseJSON rejects non-array payloads', () => {
  assert.deepStrictEqual(safeParseJSON(`{"some": "object"}`), []);
  assert.deepStrictEqual(safeParseJSON(`"a string"`), []);
  assert.deepStrictEqual(safeParseJSON(`123`), []);
  assert.deepStrictEqual(safeParseJSON(`null`), []);
  assert.deepStrictEqual(safeParseJSON(``), []);
});

test('7. safeParseJSON preserves normal API response objects', () => {
  const parsed = safeParseJSON(JSON.stringify([
    { rid: '123', data: 'תל אביב', alertDate: '2026-04-10', category: 1 },
    { rid: '456', data: 'חיפה', alertDate: '2026-04-11', category: 2 },
  ]));
  assert.strictEqual(parsed.length, 2, 'Normal objects must not be filtered out');
  assert.strictEqual(parsed[0].rid, '123');
  assert.strictEqual(parsed[1].data, 'חיפה');
});

// ── Rate limiting ───────────────────────────────────────────────────────

test('8. Rate limiter blocks requests past the window maximum', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 60 });
  let blocked = 0;
  for (let i = 0; i < 65; i += 1) if (limiter.isLimited('test-ip')) blocked += 1;
  limiter.stop();
  assert.strictEqual(blocked, 5);
});

test('9. clientIp ignores X-Forwarded-For unless the proxy is trusted', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.9' },
    socket: { remoteAddress: '198.51.100.7' },
  };
  // Default deployment: the header is attacker-controlled, use the socket
  assert.strictEqual(clientIp(req, false), '198.51.100.7');
  // Behind our own reverse proxy: leftmost hop is the real client
  assert.strictEqual(clientIp(req, true), '1.2.3.4');

  const bare = { headers: {}, socket: { remoteAddress: '198.51.100.7' } };
  assert.strictEqual(clientIp(bare, true), '198.51.100.7');
  const blank = { headers: { 'x-forwarded-for': '  ' }, socket: { remoteAddress: '198.51.100.7' } };
  assert.strictEqual(clientIp(blank, true), '198.51.100.7');
});

test('10. Rotating X-Forwarded-For cannot bypass the rate limit', async () => {
  resetLimits();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const statuses = [];
  for (let i = 0; i < baseConfig.rateLimitMax + 5; i += 1) {
    const res = await fetch(url, { headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
    statuses.push(res.status);
    await res.text();
  }
  const blocked = statuses.filter((status) => status === 429).length;
  assert.strictEqual(blocked, 5, `Expected 5 rate-limited requests, got ${blocked}`);
  assert.strictEqual(app.locals.rateLimiter.hits.size, 1,
    'Spoofed headers must not create extra rate-limit entries');
});

// ── SSE connection cap ──────────────────────────────────────────────────

async function floodSse(route, total) {
  const requests = [];
  const statusCodes = [];
  const batch = 40;

  for (let opened = 0; opened < total; opened += batch) {
    resetLimits();
    const count = Math.min(batch, total - opened);
    await Promise.all(Array.from({ length: count }, () => new Promise((resolve) => {
      const req = http.get(`${baseUrl}${route}`, (res) => {
        statusCodes.push(res.statusCode);
        res.resume();
        resolve();
      });
      req.on('error', () => resolve());
      requests.push(req);
    })));
  }
  return { statusCodes, close: () => requests.forEach((req) => req.destroy()) };
}

test('11. SSE connection cap is enforced on the live event stream', async () => {
  const { statusCodes, close } = await floodSse('/api/v1/events', baseConfig.maxSseListeners + 10);
  try {
    assert.ok(statusCodes.includes(503),
      `Expected at least one 503, got: ${JSON.stringify([...new Set(statusCodes)])}`);
  } finally {
    close();
  }
});

test('12. SSE connection cap is enforced on the ranking stream', async () => {
  // Streams from test 11 are released asynchronously; give the registry a tick.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const { statusCodes, close } = await floodSse('/api/alerts/stream', baseConfig.maxSseListeners + 10);
  try {
    assert.ok(statusCodes.includes(503),
      `Expected at least one 503, got: ${JSON.stringify([...new Set(statusCodes)])}`);
  } finally {
    close();
  }
});

// ── Admin surface ───────────────────────────────────────────────────────

test('13. Test-alert endpoint is disabled by default and needs a token', async () => {
  resetLimits();
  const res = await fetch(`${baseUrl}/api/v1/test-alert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ areas: ['אופקים'] }),
  });
  await res.text();
  assert.strictEqual(res.status, 404, 'Disabled endpoint must not be reachable');
});

test('14. Action reload rejects unauthenticated callers', async () => {
  resetLimits();
  const res = await fetch(`${baseUrl}/api/v1/actions/reload`, { method: 'POST' });
  await res.text();
  assert.strictEqual(res.status, 401);
});

// ── Early warning ───────────────────────────────────────────────────────

test('15. Early warning is published as pre_alert and exposed on the live state', async () => {
  resetLimits();
  bus.publishCandidate({
    candidateId: 'pre-alert-regression',
    source: 'test-source',
    rawId: 'pre-1',
    kind: 'pre_alert',
    category: 14,
    threat: 'preAlert',
    severity: 2,
    title: 'איום מלבנון - התקרבו למרחב מוגן',
    instructions: '',
    areas: ['מטולה'],
    areaIds: [],
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    raw: null,
    test: false,
  });

  const state = await (await fetch(`${baseUrl}/api/v1/state`)).json();
  assert.strictEqual(state.status, 'pre_alert');
  assert.strictEqual(state.preAlertCount, 1);
  const area = state.areas.find((item) => item.area === 'מטולה');
  assert.ok(area, 'Pre-alert area must appear in the live state');
  assert.strictEqual(area.category, 14);
  assert.strictEqual(area.severity, 2);
  // Geo metadata comes from the vendored catalog, not the removed package.
  assert.strictEqual(typeof area.detail.lat, 'number');
});
