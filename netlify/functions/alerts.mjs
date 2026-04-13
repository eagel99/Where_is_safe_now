export const config = {
  path: "/api/alerts",
};

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
const HEBREW_LETTERS = "אבגדהוזחטיכלמנסעפצקרשת".split("");
const DIRECTIONS = new Set(["צפון", "דרום", "מזרח", "מערב"]);
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 150;

// Restrict CORS to same-origin; override via ALLOWED_ORIGIN env var if needed
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const CORS_HEADERS = {
  "Content-Type": "application/json",
  ...(ALLOWED_ORIGIN
    ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN }
    : {}),
  "X-Content-Type-Options": "nosniff",
};

function fmt(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(
    d.getMonth() + 1
  ).padStart(2, "0")}.${d.getFullYear()}`;
}

function safeParseJSON(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  // Filter out prototype pollution attempts (check OWN properties only)
  return parsed.filter(
    (item) =>
      item != null &&
      typeof item === "object" &&
      !Object.hasOwn(item, "__proto__") &&
      !Object.hasOwn(item, "constructor")
  );
}

function getBaseCity(name) {
  if (!name || !name.includes(" - ")) return name || "Unknown";
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

async function discoverCities() {
  const citySet = new Set();
  for (let i = 0; i < HEBREW_LETTERS.length; i += BATCH_SIZE) {
    const batch = HEBREW_LETTERS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((l) =>
        apiFetch(`lang=he&mode=1&city_0=${encodeURIComponent(l)}`)
      )
    );
    for (const alerts of results)
      for (const a of alerts) if (a.data) citySet.add(a.data);
    if (i + BATCH_SIZE < HEBREW_LETTERS.length) await delay(BATCH_DELAY_MS);
  }
  return [...citySet].sort();
}

export default async () => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromDate = fmt(weekAgo);
    const toDate = fmt(now);
    const cutoff = weekAgo.getTime();

    // Phase 1 – discover every area name the API knows
    const cities = await discoverCities();

    // Phase 2 – query each area individually
    const allAlerts = [];
    for (let i = 0; i < cities.length; i += BATCH_SIZE) {
      const batch = cities.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((city) =>
          apiFetch(
            `lang=he&mode=1&fromDate=${fromDate}&toDate=${toDate}&city_0=${encodeURIComponent(city)}`
          )
        )
      );
      for (const alerts of results) allAlerts.push(...alerts);
      if (i + BATCH_SIZE < cities.length) await delay(BATCH_DELAY_MS);
    }

    // Deduplicate by rid
    const seen = new Set();
    const unique = allAlerts.filter((a) => {
      if (seen.has(a.rid)) return false;
      seen.add(a.rid);
      return true;
    });

    // Filter: missiles only + within last 7 days
    const missileAlerts = unique.filter((a) => {
      const t = new Date(a.alertDate).getTime();
      return a.category === CATEGORY_MISSILES && t >= cutoff;
    });

    // Count per sub-region
    const subCounts = {};
    for (const alert of missileAlerts) {
      const city = alert.data || "Unknown";
      subCounts[city] = (subCounts[city] || 0) + 1;
    }

    // Merge sub-regions → base city, keep the MAX count
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
      sorted.length > 3
        ? sorted.slice(-3).reverse()
        : sorted.slice().reverse();

    return new Response(
      JSON.stringify({
        most,
        least,
        totalAlerts: missileAlerts.length,
        totalCities: sorted.length,
        fromDate,
        toDate,
        updatedAt: now.toISOString(),
      }),
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: CORS_HEADERS,
    });
  }
};