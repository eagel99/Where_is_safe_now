import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const API_BASE =
  "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx";

const BROWSER_HEADERS = {
  Referer: "https://alerts-history.oref.org.il/12481-he/Pakar.aspx",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "he-IL,he;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Origin: "https://alerts-history.oref.org.il",
};

const CATEGORY_MISSILES = 1;
const SUB_REGIONS = ["צפון", "דרום", "מזרח", "מערב"];
const DIRECTIONS = new Set(SUB_REGIONS);
const REQUEST_DELAY_MS = 300;
const ALERTS_CACHE_TTL = 5 * 60 * 1000;

let alertsCache = null;
let alertsCacheTime = 0;

// ── SSE streaming infrastructure ────────────────────────────────────────
let queryPromise = null;
let streamListeners = [];

function addListener(fn) {
  streamListeners.push(fn);
}
function removeListener(fn) {
  streamListeners = streamListeners.filter((l) => l !== fn);
}
function broadcast(eventName, data) {
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  const listeners = [...streamListeners];
  for (const fn of listeners) fn(msg);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function fmt(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(
    d.getMonth() + 1
  ).padStart(2, "0")}.${d.getFullYear()}`;
}

function safeParseJSON(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function normalizeCity(name) {
  return (name || "Unknown")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBaseCity(name) {
  name = normalizeCity(name);
  if (!name.includes(" - ")) return name;
  const idx = name.indexOf(" - ");
  const left = name.substring(0, idx).trim();
  const right = name.substring(idx + 3).trim();

  if (DIRECTIONS.has(right)) return left;
  if (left.startsWith("אזור התעשיה") || left.startsWith("אזור תעשיה"))
    return right;
  return left;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch(params) {
  const url = `${API_BASE}?${params}`;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) return [];
    return safeParseJSON(await res.text());
  } catch {
    return [];
  }
}

async function loadCities() {
  const csv = await readFile(
    resolve(__dirname, "israel_cities_2026.csv"),
    "utf-8"
  );
  return csv
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/\*/g, ""))
    .filter(Boolean);
}

function getCityVariants(city) {
  return [city, ...SUB_REGIONS.map((dir) => `${city} - ${dir}`)];
}

function computeRankings(subCounts, fromDate, toDate, updatedAt) {
  const baseCityCounts = {};
  for (const [subRegion, count] of Object.entries(subCounts)) {
    const base = getBaseCity(subRegion);
    baseCityCounts[base] = Math.max(baseCityCounts[base] || 0, count);
  }

  const sorted = Object.entries(baseCityCounts)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  const most = sorted.slice(0, 3);
  const least =
    sorted.length > 3 ? sorted.slice(-3).reverse() : sorted.slice().reverse();
  const totalAlerts = Object.values(subCounts).reduce((s, c) => s + c, 0);

  return {
    most,
    least,
    allCities: sorted,
    totalAlerts,
    totalCities: sorted.length,
    fromDate,
    toDate,
    updatedAt,
  };
}

// ── Main query – broadcasts SSE events as it progresses ─────────────────
async function runQuery() {
  const cities = await loadCities();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = fmt(weekAgo);
  const toDate = fmt(now);
  const cutoff = weekAgo.getTime();
  const updatedAt = now.toISOString();

  const allVariants = cities.flatMap(getCityVariants);
  const seen = new Set();
  const subCounts = {};

  console.log(
    `🚀 Fetching: ${cities.length} cities × 5 = ${allVariants.length} queries (${fromDate} → ${toDate})`
  );

  for (let i = 0; i < allVariants.length; i++) {
    const variant = allVariants[i];
    const alerts = await apiFetch(
      `lang=he&mode=2&fromDate=${fromDate}&toDate=${toDate}&city_0=${encodeURIComponent(variant)}`
    );

    let hasNewMissiles = false;
    for (const a of alerts) {
      if (!seen.has(a.rid)) {
        seen.add(a.rid);
        const t = new Date(a.alertDate).getTime();
        if (a.category === CATEGORY_MISSILES && t >= cutoff) {
          const city = normalizeCity(a.data);
          subCounts[city] = (subCounts[city] || 0) + 1;
          hasNewMissiles = true;
        }
      }
    }

    if (alerts.length > 0) {
      const missiles = alerts.filter((a) => a.category === CATEGORY_MISSILES);
      console.log(
        `   ✓ ${variant}  → ${alerts.length} total, ${missiles.length} missiles`
      );
    }

    broadcast("progress", {
      done: i + 1,
      total: allVariants.length,
      city: variant,
    });

    if (hasNewMissiles) {
      broadcast("update", computeRankings(subCounts, fromDate, toDate, updatedAt));
    }

    await delay(REQUEST_DELAY_MS);
  }

  const result = computeRankings(subCounts, fromDate, toDate, updatedAt);
  alertsCache = result;
  alertsCacheTime = Date.now();

  broadcast("done", result);
  console.log(
    `   ✅ Done! ${result.totalAlerts} missiles across ${result.totalCities} cities`
  );

  return result;
}

async function fetchAlerts() {
  if (alertsCache && Date.now() - alertsCacheTime < ALERTS_CACHE_TTL) {
    return alertsCache;
  }
  if (queryPromise) return queryPromise;

  queryPromise = runQuery();
  try {
    return await queryPromise;
  } finally {
    queryPromise = null;
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // SSE streaming endpoint
  if (req.url === "/api/alerts/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // If cached, send final result immediately
    if (alertsCache && Date.now() - alertsCacheTime < ALERTS_CACHE_TTL) {
      res.write(`event: done\ndata: ${JSON.stringify(alertsCache)}\n\n`);
      res.end();
      return;
    }

    const listener = (msg) => {
      if (res.destroyed) {
        removeListener(listener);
        return;
      }
      res.write(msg);
      if (msg.startsWith("event: done") || msg.startsWith("event: error")) {
        removeListener(listener);
        res.end();
      }
    };

    addListener(listener);
    req.on("close", () => removeListener(listener));

    // Start query if not already running
    if (!queryPromise) {
      queryPromise = runQuery();
      queryPromise.finally(() => {
        queryPromise = null;
      });
    }
    return;
  }

  // Regular JSON endpoint (returns cached or waits for full result)
  if (req.url === "/api/alerts") {
    try {
      const data = await fetchAlerts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("❌", err.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  try {
    const html = await readFile(resolve(__dirname, "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  🚀 Dashboard: http://localhost:${PORT}\n`);
});