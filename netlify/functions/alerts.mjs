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
      },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Upstream ${res.status}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const alerts = await res.json();

    // category 1 = rocket / missile alerts
    const missileAlerts = Array.isArray(alerts)
      ? alerts.filter((a) => a.category === 1 || a.cat === "1")
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
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/alerts",
};