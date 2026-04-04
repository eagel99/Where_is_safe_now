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
const CATEGORY_UAV = 2;
const ALERT_CATEGORIES = new Set([CATEGORY_MISSILES, CATEGORY_UAV]);

const SUB_REGIONS = ["צפון", "דרום", "מזרח", "מערב"];
const DIRECTIONS = new Set(SUB_REGIONS);
const CUSTOM_SUB_REGIONS = {
  "אשדוד": [
    "א,ב,ד,ה",
    "איזור תעשייה צפוני",
    "ג,ו,ז",
    "ח,ט,י,יג,יד,טז",
    "יא,יב,טו,יז,מרינה,סיטי",
  ],
  "צפת": [
    "נוף כנרת",
    "עיר",
    "עכברה",
  ],
  "תל אביב": [
    "דרום העיר ויפו",
    "מזרח",
    "מרכז העיר",
    "עבר הירקון",
  ],
  "הרצליה": [
    "מרכז וגליל ים",
  ],
  "חדרה": [
    "נווה חיים",
  ],
  "חיפה": [
    "בת גלים ק.אליעזר",
    "כרמל, הדר ועיר תחתית",
    "מערב",
    "מפרץ",
    "נווה שאנן ורמות כרמל",
    "קריית חיים ושמואל",
  ],
  "ירושלים": [
    "אזור תעשייה עטרות",
    "דרום",
    "כפר עקב",
    "מזרח",
    "מערב",
    "מרכז",
    "צפון",
  ],
};
const REQUEST_DELAY_MS = 300;
const BATCH_SIZE = 10;
const ALERTS_CACHE_TTL = 2 * 60 * 1000;

// ── Zone pruning ────────────────────────────────────────────────────────
const ZONE_INACTIVE_TTL = 3 * 24 * 60 * 60 * 1000;   // 3 days
const FULL_SCAN_INTERVAL = 4 * 24 * 60 * 60 * 1000;   // 4 days

const zoneActivity = new Map();  // variant → last alert timestamp
let hasCompletedFullScan = false;
let lastFullScanTime = 0;

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
  if (left.startsWith("אזור התעשיה") || left.startsWith("אזור תעשייה"))
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

const CUSTOM_ONLY = new Set(["אשדוד", "צפת", "תל אביב", "חיפה", "ירושלים"]);

function getCityVariants(city) {
  const extras = CUSTOM_SUB_REGIONS[city];
  if (extras) {
    const variants = [city, ...extras.map((sub) => `${city} - ${sub}`)];
    if (!CUSTOM_ONLY.has(city)) {
      variants.push(...SUB_REGIONS.map((dir) => `${city} - ${dir}`));
    }
    return variants;
  }
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

  // Zone pruning: full scan on first run or every 4 days, otherwise skip inactive zones
  const nowMs = Date.now();
  const needsFullScan =
    !hasCompletedFullScan || nowMs - lastFullScanTime > FULL_SCAN_INTERVAL;

  const queryVariants = needsFullScan
    ? allVariants
    : allVariants.filter((v) => {
        if (!v.includes(" - ")) return true; // always query base cities
        const lastActive = zoneActivity.get(v);
        return lastActive !== undefined && nowMs - lastActive < ZONE_INACTIVE_TTL;
      });

  const seen = new Set();
  const subCounts = {};
  const skipped = allVariants.length - queryVariants.length;

  console.log(
    `🚀 Fetching: ${queryVariants.length}/${allVariants.length} variants` +
      (needsFullScan
        ? " (full scan)"
        : ` (optimized, ${skipped} inactive zones pruned)`) +
      ` in batches of ${BATCH_SIZE} (${fromDate} → ${toDate})`
  );

  let done = 0;
  let batchHasNewAlerts = false;

  for (let b = 0; b < queryVariants.length; b += BATCH_SIZE) {
    const batch = queryVariants.slice(b, b + BATCH_SIZE);

    // Fetch all variants in this batch concurrently
    const results = await Promise.all(
      batch.map(async (variant) => {
        const alerts = await apiFetch(
          `lang=he&mode=2&fromDate=${fromDate}&toDate=${toDate}&city_0=${encodeURIComponent(variant)}`
        );
        return { variant, alerts };
      })
    );

    // Process results sequentially (shared seen/subCounts state)
    for (const { variant, alerts } of results) {
      let hasNewAlerts = false;
      for (const a of alerts) {
        if (!seen.has(a.rid)) {
          seen.add(a.rid);
          const t = new Date(a.alertDate).getTime();
          if (ALERT_CATEGORIES.has(a.category) && t >= cutoff) {
            const city = normalizeCity(a.data);
            subCounts[city] = (subCounts[city] || 0) + 1;
            hasNewAlerts = true;
          }
        }
      }

      // Track zone activity — mark active if API returned any relevant alerts
      if (alerts.some((a) => ALERT_CATEGORIES.has(a.category))) {
        zoneActivity.set(variant, Date.now());
      }

      if (alerts.length > 0) {
        const relevant = alerts.filter((a) => ALERT_CATEGORIES.has(a.category));
        const catCounts = {};
        for (const a of alerts) {
          catCounts[a.category] = (catCounts[a.category] || 0) + 1;
        }
        console.log(
          `   ✓ ${variant}  → ${alerts.length} total, ${relevant.length} missiles/UAVs | categories: ${JSON.stringify(catCounts)}`
        );
      }

      if (hasNewAlerts) batchHasNewAlerts = true;
      done++;
    }

    broadcast("progress", {
      done,
      total: queryVariants.length,
      city: batch[batch.length - 1],
    });

    if (batchHasNewAlerts) {
      broadcast("update", computeRankings(subCounts, fromDate, toDate, updatedAt));
      batchHasNewAlerts = false;
    }

    // Delay between batches, not between individual requests
    if (b + BATCH_SIZE < queryVariants.length) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  if (needsFullScan) {
    hasCompletedFullScan = true;
    lastFullScanTime = Date.now();
  }

  const result = computeRankings(subCounts, fromDate, toDate, updatedAt);
  alertsCache = result;
  alertsCacheTime = Date.now();

  broadcast("done", result);

  const citiesWithAlerts = new Set(
    Object.keys(subCounts).map(getBaseCity)
  );
  const citiesWithoutAlerts = cities.filter((c) => !citiesWithAlerts.has(c));
  const activeZones = [...zoneActivity.values()].filter(
    (t) => Date.now() - t < ZONE_INACTIVE_TTL
  ).length;

  console.log(
    `   ✅ Done! ${result.totalAlerts} alerts (missiles + UAVs) across ${result.totalCities} cities`
  );
  console.log(
    `   📊 Zones: ${activeZones} active / ${zoneActivity.size} tracked (inactive pruned after 3 days)`
  );
  if (citiesWithoutAlerts.length > 0) {
    console.log(
      `   ℹ️ Cities with 0 alerts (${citiesWithoutAlerts.length}): ${citiesWithoutAlerts.join(", ")}`
    );
  }

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

// ── Auto-refresh loop ───────────────────────────────────────────────────
async function autoRefreshLoop() {
  while (true) {
    try {
      await fetchAlerts();
    } catch (e) {
      console.error("❌ Auto-refresh failed:", e.message);
    }
    await delay(ALERTS_CACHE_TTL);
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

    // Subscribe to already-running query (started by autoRefreshLoop)
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
  autoRefreshLoop(); // Start fetching immediately, no client needed
});