export const config = {
  path: "/api/alerts",
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// Normalize alerts from different API formats into { city, category }
function normalizeAlerts(data) {
  if (!Array.isArray(data)) return [];

  return data.flatMap((item) => {
    // Format A — Tzeva Adom: { cities: [...], threat: 0 }
    if (Array.isArray(item.cities)) {
      return item.cities.map((city) => ({
        city,
        isMissile: item.threat === 0 || item.threat === "0",
      }));
    }

    // Format B — Oref official: { data: "city", category: 1 }
    return [
      {
        city: item.data || item.title || "Unknown",
        isMissile:
          item.category === 1 ||
          item.category === "1" ||
          item.cat === 1 ||
          item.cat === "1",
      },
    ];
  });
}

async function tryFetch(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchAlerts(fromDate, toDate) {
  const sources = [
    // 1. Tzeva Adom community API
    `https://api.tzevaadom.co.il/notifications`,
    // 2. Official Oref via AllOrigins proxy
    `https://api.allorigins.win/raw?url=${encodeURIComponent(
      `https://www.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`
    )}`,
    // 3. Official Oref via corsproxy
    `https://corsproxy.io/?${encodeURIComponent(
      `https://www.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`
    )}`,
  ];

  const errors = [];

  for (const url of sources) {
    try {
      const data = await tryFetch(url, BROWSER_HEADERS);
      if (data && Array.isArray(data) && data.length > 0) {
        return { data, source: url.split("/")[2] };
      }
    } catch (err) {
      errors.push({ url: url.split("/")[2], error: err.message });
    }
  }

  return { data: null, errors };
}

export default async (req) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const fmt = (d) =>
      `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

    const result = await fetchAlerts(fmt(weekAgo), fmt(now));

    if (!result.data) {
      return new Response(
        JSON.stringify({
          error: "All alert data sources are unavailable.",
          details: result.errors || [],
        }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Normalize from whichever source responded
    const allAlerts = normalizeAlerts(result.data);
    const missileAlerts = allAlerts.filter((a) => a.isMissile);

    // Filter to last 7 days (in case the API returns more)
    const counts = {};
    for (const alert of missileAlerts) {
      counts[alert.city] = (counts[alert.city] || 0) + 1;
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
        fromDate: fmt(weekAgo),
        toDate: fmt(now),
        updatedAt: now.toISOString(),
        source: result.source,
      }),
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=30",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
};