export const config = {
  path: "/api/alerts",
};

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

const CATEGORY_MISSILES = 1;

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

function fmt(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

export default async (req) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromDate = fmt(weekAgo);
    const toDate = fmt(now);

    const url = `${API_BASE}?lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `API returned ${res.status}` }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const raw = await res.text();
    const trimmed = raw.trim();
    const alerts = trimmed ? JSON.parse(trimmed) : [];

    if (!Array.isArray(alerts)) {
      return new Response(
        JSON.stringify({ error: "Unexpected response format" }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const cutoff = weekAgo.toISOString();
    const missileAlerts = alerts.filter(
      (a) => a.category === CATEGORY_MISSILES && a.alertDate >= cutoff
    );

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
        headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=30" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
};