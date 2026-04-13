import { test, describe } from "node:test";
import assert from "node:assert";
import http from "node:http";
import {
  server,
  safeParseJSON,
  isRateLimited,
  rateLimitMap,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "./server.mjs";

describe("Security Tests", () => {
  // Setup server for HTTP tests
  const PORT = 3001;
  const baseUrl = `http://localhost:${PORT}`;

  let requestCount = 0;

  test.before((done) => {
    server.listen(PORT, done);
  });

  test.after((done) => {
    server.close(done);
  });

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
    // There shouldn't be easy error leakages, but if we do get 502/500, they just contain {error:"Failed to fetch alert data"} or "Internal server error"
    const res = await fetch(`${baseUrl}/api/alerts`);
    // Assuming the API might fail because it calls out without valid connection
    const text = await res.text();
    assert.ok(!text.includes("ReferenceError") && !text.includes("TypeError"));
  });

  test("5. safeParseJSON rejects prototype pollution payloads", () => {
    const maliciousJson = `[{"__proto__": {"polluted": "yes"}, "city": "Test"}]`;
    const parsed = safeParseJSON(maliciousJson);

    // Create an empty object, ensure it's not polluted
    const obj = {};
    assert.strictEqual(obj.polluted, undefined);

    // The parsed array should not contain __proto__ or filter it completely
    assert.strictEqual(parsed.length, 0); // Our filter drops the polluted item entirely
  });

  test("6. safeParseJSON rejects non-array payloads", () => {
    assert.deepStrictEqual(safeParseJSON(`{"some": "object"}`), []);
    assert.deepStrictEqual(safeParseJSON(`"a string"`), []);
    assert.deepStrictEqual(safeParseJSON(`123`), []);
    assert.deepStrictEqual(safeParseJSON(`null`), []);
    assert.deepStrictEqual(safeParseJSON(``), []);
  });

  test("8. Rate limiter blocks excessive requests", async () => {
    const ip = "127.0.0.1";
    let blockCount = 0;

    // Clear the map for test isolation
    rateLimitMap.clear();

    for (let i = 0; i < RATE_LIMIT_MAX + 5; i++) {
      if (isRateLimited(ip)) {
        blockCount++;
      }
    }

    // Exactly 5 should be blocked
    assert.strictEqual(blockCount, 5);
  });

  test("4. SSE connection limit is enforced", async () => {
    const localConnections = [];
    let tooManyFound = false;

    // Invalidate cache so connections don't instantly close
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 3 * 60 * 1000;

    // The max is MAX_SSE_LISTENERS = 100
    try {
      for (let i = 0; i < 110; i++) {
        // Bypass the 60/min IP-based rate limiter so we can reach 100 connections
        if (i % 50 === 0) rateLimitMap.clear();

        const req = http.get(`${baseUrl}/api/alerts/stream`, (res) => {
          if (res.statusCode === 503) {
            tooManyFound = true;
          }
        });
        localConnections.push(req);
      }

      // Wait briefly for responses
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(tooManyFound, true);

    } finally {
      for (const req of localConnections) {
        req.destroy();
      }
    }
  });

});
