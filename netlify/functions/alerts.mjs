export const config = {
  path: "/api/alerts",
};

const HEADERS = {
  Referer: "https://www.oref.org.il/",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "he",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

async function fetchAlerts(fromDate, toDate) {
  // Try multiple known Pikud HaOref endpoints
  const urls = [
    `https://www.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`,
    `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json?lang=he&fromDate=${fromDate}&toDate=${toDate}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;

      const raw = await res.text();
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
    } catch {
      continue;
    }
  }

  return null;
}

export default async (req) => {
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const fmt = (d) =>
      `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

    const alerts = await fetchAlerts(fmt(weekAgo), fmt(now));

    if (alerts === null) {
      return new Response(
        JSON.stringify({
          error:
            "Pikud HaOref API is blocking requests from this server. " +
            "The API restricts access to Israeli IPs only.",
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    // category 1 = rocket / missile alerts
    const missileAlerts = alerts.filter(
      (a) =>
        a.category === 1 ||
        a.category === "1" ||
        a.cat === 1 ||
        a.cat === "1"
    );

    // Count per city
    const counts = {};
    for (const alert of missileAlerts) {
      const city = alert.data || alert.title || "Unknown";
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
        fromDate: fmt(weekAgo),
        toDate: fmt(now),
        updatedAt: now.toISOString(),
      }),
      {
        headers: {
          ...corsHeaders,
          "Cache-Control": "public, max-age=30",
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};