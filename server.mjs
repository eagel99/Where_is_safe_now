import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

const API_BASE = "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx";

const BROWSER_HEADERS = {
  Referer: "https://alerts-history.oref.org.il/12481-he/Pakar.aspx",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "he-IL,he;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Origin: "https://alerts-history.oref.org.il",
};

// Missile/rocket category
const CATEGORY_MISSILES = 1;

function fmt(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function safeParseJSON(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

async function fetchAlerts() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromDate = fmt(weekAgo);
  const toDate = fmt(now);

  const url = `${API_BASE}?lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`;

  console.log(`🔍 Fetching: ${fromDate} → ${toDate}`);

  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`API returned ${res.status}`);

  const raw = await res.text();
  const alerts = safeParseJSON(raw);

  if (!Array.isArray(alerts)) throw new Error("Unexpected response format");

  // Filter: missiles only + last 7 days (in case API returns more)
  const cutoff = weekAgo.toISOString();
  const missileAlerts = alerts.filter(
    (a) => a.category === CATEGORY_MISSILES && a.alertDate >= cutoff
  );

  console.log(`   Total: ${alerts.length} | Missiles (7d): ${missileAlerts.length}`);

  // Count per city
  const counts = {};
  for (const alert of missileAlerts) {
    const city = alert.data || "Unknown";
    counts[city] = (counts[city] || 0) + 1;
  }

  const sorted = Object.entries(counts)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  const most = sorted.slice(0, 3);
  const least =
    sorted.length > 3 ? sorted.slice(-3).reverse() : sorted.slice().reverse();

  return {
    most,
    least,
    totalAlerts: missileAlerts.length,
    totalCities: sorted.length,
    fromDate,
    toDate,
    updatedAt: now.toISOString(),
  };
}

const server = createServer(async (req, res) => {
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