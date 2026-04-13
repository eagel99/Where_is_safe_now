import { test, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import {
  server,
  safeParseJSON,
  isRateLimited,
  rateLimitMap,
  RATE_LIMIT_MAX,
} from "./server.mjs";

// ── Server lifecycle (top-level, avoids worker serialization issues) ────
const PORT = 3001;
const baseUrl = `http://localhost:${PORT}`;

before(() => new Promise((resolve) => server.listen(PORT, resolve)));
after(() => new Promise((resolve) => server.close(resolve)));

// ── Tests ───────────────────────────────────────────────────────────────

test("1 & 7. Unknown routes return 404 & route validation", async () => {
  const res1 = await fetch(`${baseUrl}/valid-does-not-exist`);
  assert.strictEqual(res1.status, 404);

  const res2 = await fetch(`${baseUrl}/../etc/passwd`);
  assert.strictEqual(res2.status, 404);

  // Explicit valid ones
  const res3 = await fetch(`${baseUrl}/`);
  assert.strictEqual(res3.status, 200);

  const res4 = await fetch(`${baseUrl}/index.html`);
  assert.strictEqual(res4.status, 200);
});

test("2. Security headers present on all responses", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
  assert.strictEqual(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("content-security-policy"));
});

test("3. Error responses don't leak internals", async () => {
  const res = await fetch(`${baseUrl}/api/alerts`);
  const text = await res.text();
  assert.ok(!text.includes("ReferenceError") && !text.includes("TypeError"));
});

test("5. safeParseJSON rejects prototype pollution payloads", () => {
  const maliciousJson = `[{"__proto__": {"polluted": "yes"}, "city": "Test"}]`;
  const parsed = safeParseJSON(maliciousJson);

  const obj = {};
  assert.strictEqual(obj.polluted, undefined);
  assert.strictEqual(parsed.length, 0);
});

test("6. safeParseJSON rejects non-array payloads", () => {
  assert.deepStrictEqual(safeParseJSON(`{"some": "object"}`), []);
  assert.deepStrictEqual(safeParseJSON(`"a string"`), []);
  assert.deepStrictEqual(safeParseJSON(`123`), []);
  assert.deepStrictEqual(safeParseJSON(`null`), []);
  assert.deepStrictEqual(safeParseJSON(``), []);
});

test("8. Rate limiter blocks excessive requests", () => {
  const ip = "test-rate-limit-ip";
  let blockCount = 0;

  rateLimitMap.clear();

  for (let i = 0; i < RATE_LIMIT_MAX + 5; i++) {
    if (isRateLimited(ip)) {
      blockCount++;
    }
  }

  assert.strictEqual(blockCount, 5);
});

test("4. SSE connection limit is enforced", async () => {
  const connections = [];
  const statusCodes = [];

  // Invalidate cache so SSE connections stay open (don't get instant cached response)
  const originalDateNow = Date.now;
  Date.now = () => originalDateNow() + 3 * 60 * 1000;

  try {
    // Open connections in batches of 50 (under the rate limit of 60)
    const BATCH = 50;
    const TOTAL = 110;

    for (let batch = 0; batch < TOTAL; batch += BATCH) {
      rateLimitMap.clear();
      const count = Math.min(BATCH, TOTAL - batch);
      const batchPromises = [];

      for (let i = 0; i < count; i++) {
        batchPromises.push(
          new Promise((resolve) => {
            const req = http.get(`${baseUrl}/api/alerts/stream`, (res) => {
              statusCodes.push(res.statusCode);
              resolve();
            });
            req.on("error", () => resolve());
            connections.push(req);
          })
        );
      }

      await Promise.all(batchPromises);
    }

    const got503 = statusCodes.some((code) => code === 503);
    assert.strictEqual(got503, true, `Expected at least one 503, got: ${JSON.stringify([...new Set(statusCodes)])}`);
  } finally {
    Date.now = originalDateNow;
    for (const req of connections) {
      req.destroy();
    }
  }
});
