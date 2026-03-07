export default async (req) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const fmt = (d) =>
      `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

    const url =
      `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json` +
      `?lang=he&fromDate=${fmt(weekAgo)}&toDate=${fmt(now)}`;

    const res = await fetch(url, {
      headers: {
        Referer: "https://www.oref.org.il/",
        "X-Requested-With": "XMLHttpRequest",
        "Accept-Language": "he",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return new Response(
        JSON.stringify({ error: `Upstream ${res.status}`, detail: body.slice(0, 200) }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    const raw = await res.text();
    let alerts;
    try {
      alerts = JSON.parse(raw);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON from upstream", detail: raw.slice(0, 200) }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }
      );
    }

    // category 1 = rocket / missile alerts
    const missileAlerts = Array.isArray(alerts)
      ? alerts.filter(
          (a) =>
            a.category === 1 ||
            a.category === "1" ||
            a.cat === 1 ||
            a.cat === "1"
        )
      : [];

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
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
};

export const config = {
  path: "/api/alerts",
};