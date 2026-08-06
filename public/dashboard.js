// Ranking dashboard (7-day history) plus the live alert banner fed by the
// aggregated real-time sources. Extracted from an inline <script> so the page
// runs under a `script-src 'self'` CSP.

const STREAM_API = "/api/alerts/stream";
const API = "/api/alerts";
const LIVE_STATE_API = "/api/v1/state";
const LIVE_EVENTS_API = "/api/v1/events";
const INTERVAL = 60_000;

let currentData = null;
let selectedCity = "";

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Live alert banner ─────────────────────────────────────────────────
// `status` is the highest-severity area state: alert > pre_alert > end/clear.
const LIVE_LABELS = {
  alert: "התרעה פעילה",
  pre_alert: "התרעה מקדימה",
  end: "האירוע הסתיים",
  clear: "אין התרעה פעילה",
};

function renderLive(state) {
  const banner = document.getElementById("liveBanner");
  const badge = document.getElementById("liveBadge");
  const title = document.getElementById("liveTitle");
  const areasEl = document.getElementById("liveAreas");
  const countEl = document.getElementById("liveCount");
  if (!banner) return;

  const status = state?.status || "clear";
  const areas = Array.isArray(state?.areas) ? state.areas : [];
  const live = areas.filter((area) => area.kind === "alert" || area.kind === "pre_alert");

  banner.className = `live-banner ${status === "end" ? "clear" : status}`;
  badge.textContent = LIVE_LABELS[status] || LIVE_LABELS.clear;
  countEl.textContent = String(state?.activeCount ?? 0);

  if (!live.length) {
    title.textContent = "אין התרעות פעילות. המערכת מנטרת את מקורות פיקוד העורף.";
    areasEl.textContent = "";
    return;
  }

  // The top-severity area drives the headline; the rest are listed below it.
  title.textContent = live[0].title || LIVE_LABELS[status];
  const preAlertCount = state?.preAlertCount ?? 0;
  const prefix = preAlertCount > 0 && status === "pre_alert"
    ? "בדקות הקרובות צפויות להתקבל התרעות באזורים: "
    : "אזורים: ";
  areasEl.textContent = prefix + live.map((area) => area.area).join(", ");
}

function markLiveOffline() {
  const banner = document.getElementById("liveBanner");
  if (!banner) return;
  banner.className = "live-banner offline";
  document.getElementById("liveBadge").textContent = "אין חיבור";
  document.getElementById("liveTitle").textContent =
    "החיבור למקורות ההתרעה נותק. אין להסתמך על מסך זה להתרעה בזמן אמת.";
  document.getElementById("liveAreas").textContent = "";
}

function connectLive() {
  fetch(LIVE_STATE_API)
    .then((res) => (res.ok ? res.json() : null))
    .then((state) => state && renderLive(state))
    .catch(() => {});

  const stream = new EventSource(LIVE_EVENTS_API);
  stream.addEventListener("connected", (event) => {
    const payload = JSON.parse(event.data);
    renderLive(payload.state);
  });
  stream.addEventListener("state", (event) => renderLive(JSON.parse(event.data)));
  // A new alert lands before the derived state does; refresh state so the
  // banner reflects the merged, area-level picture rather than one event.
  const refresh = () => {
    fetch(LIVE_STATE_API)
      .then((res) => (res.ok ? res.json() : null))
      .then((state) => state && renderLive(state))
      .catch(() => {});
  };
  stream.addEventListener("alert", refresh);
  stream.addEventListener("alert-update", refresh);
  stream.onerror = () => markLiveOffline();
}

// ── 7-day ranking ─────────────────────────────────────────────────────
function sumCounts(items) {
  return items.reduce((s, c) => s + c.count, 0);
}

function buildCityRows(items, maxCount) {
  if (!items.length) {
    return `<div class="empty-state">אין נתונים לתקופה זו</div>`;
  }
  return items
    .map(
      (item, i) => `
    <div class="city-row">
      <div class="bar" style="width:${Math.max((item.count / maxCount) * 100, 8)}%"></div>
      <span class="rank">${i + 1}</span>
      <span class="name">${escapeHTML(item.city)}</span>
      <span class="count">${item.count.toLocaleString()}</span>
    </div>`
    )
    .join("");
}

function buildCityOptions(allCities) {
  if (!allCities || !allCities.length) return "";
  return allCities
    .slice()
    .sort((a, b) => a.city.localeCompare(b.city, "he"))
    .map(
      (c) =>
        `<option value="${escapeHTML(c.city)}"${c.city === selectedCity ? " selected" : ""}>${escapeHTML(c.city)}</option>`
    )
    .join("");
}

function buildCityResult() {
  if (!selectedCity || !currentData || !currentData.allCities) {
    return `<div class="empty-state">בחר עיר מהרשימה</div>`;
  }
  const found = currentData.allCities.find((c) => c.city === selectedCity);
  const count = found ? found.count : 0;
  return `
    <div class="count-display">${count.toLocaleString()}</div>
    <div class="count-label">התרעות טילים וכטב״מים ב${escapeHTML(selectedCity)}</div>`;
}

function render(data) {
  currentData = data;
  const maxAll = data.most.length ? data.most[0].count : 1;
  const avgAlerts =
    data.totalCities > 0 ? Math.ceil(data.totalAlerts / data.totalCities) : 0;

  const dangerTotal = sumCounts(data.most);
  const safeTotal = sumCounts(data.least);

  document.getElementById("statsBar").innerHTML = `
    <div class="stat-chip">
      <div class="value">${data.totalAlerts.toLocaleString()}</div>
      <div class="label">סה״כ התרעות טילים וכטב״מים</div>
    </div>
    <div class="stat-chip">
      <div class="value">${data.totalCities.toLocaleString()}</div>
      <div class="label">ערים שהותרעו</div>
    </div>
    <div class="stat-chip">
      <div class="value">${avgAlerts.toLocaleString()}</div>
      <div class="label">ממוצע הזעקות</div>
    </div>
    <div class="stat-chip">
      <div class="value">${(data.areasKnown || 0).toLocaleString()}</div>
      <div class="label">אזורים במעקב</div>
    </div>
    <div class="stat-chip">
      <div class="value">${escapeHTML(data.fromDate)} – ${escapeHTML(data.toDate)}</div>
      <div class="label">טווח תאריכים</div>
    </div>`;

  document.getElementById("root").innerHTML = `
    <div class="grid">
      <div class="card danger">
        <h2>🔴 הכי הרבה התרעות</h2>
        <div class="card-subtitle">סה״כ ${dangerTotal.toLocaleString()} הזעקות טילים + כטב״מים</div>
        ${buildCityRows(data.most, maxAll)}
      </div>
      <div class="card your-city">
        <h2>🏙️ בעיר שלך</h2>
        <select class="city-select" id="citySelect">
          <option value="">בחר עיר...</option>
          ${buildCityOptions(data.allCities)}
        </select>
        <div class="city-result" id="cityResult">
          ${buildCityResult()}
        </div>
      </div>
      <div class="card safe">
        <h2>🟢 הכי מעט התרעות</h2>
        <div class="card-subtitle">סה״כ ${safeTotal.toLocaleString()} הזעקות טילים + כטב״מים</div>
        ${buildCityRows(data.least, maxAll)}
      </div>
    </div>`;

  const time = new Date(data.updatedAt).toLocaleTimeString("he-IL");
  // The history endpoint truncates at 3000 rows per query; say so rather than
  // presenting an undercount as complete.
  const truncNote = data.truncated
    ? " · ⚠️ חלק מהנתונים נחתכו במגבלת השרת, המספרים הם מינימום"
    : "";
  document.getElementById("footer").textContent =
    `עדכון אחרון: ${time} · מקור: פיקוד העורף${truncNote}`;
}

// Event delegation – survives innerHTML replacements
document.getElementById("root").addEventListener("change", (e) => {
  if (e.target.id === "citySelect") {
    selectedCity = e.target.value;
    const resultEl = document.getElementById("cityResult");
    if (resultEl) resultEl.innerHTML = buildCityResult();
  }
});

function renderError(msg) {
  document.getElementById("root").innerHTML = `
    <div class="error-msg">⚠️ שגיאה בטעינת הנתונים: ${escapeHTML(msg)}</div>`;
}

function connectStream() {
  const progressEl = document.getElementById("progress");
  const fillEl = document.getElementById("progressFill");
  const textEl = document.getElementById("progressText");

  progressEl.style.display = "block";

  const es = new EventSource(STREAM_API);
  let completed = false;

  es.addEventListener("progress", (e) => {
    const d = JSON.parse(e.data);
    const pct = Math.round((d.done / d.total) * 100);
    fillEl.style.width = `${pct}%`;
    textEl.textContent = `בודק: ${d.label || d.city}  (${d.done}/${d.total})`;
  });

  es.addEventListener("update", (e) => {
    render(JSON.parse(e.data));
  });

  es.addEventListener("done", (e) => {
    completed = true;
    render(JSON.parse(e.data));
    progressEl.style.display = "none";
    es.close();
    // Switch to polling the cached endpoint
    setInterval(pollCached, INTERVAL);
  });

  es.onerror = () => {
    if (!completed) {
      progressEl.style.display = "none";
      renderError("החיבור לשרת נותק");
    }
    es.close();
  };
}

async function pollCached() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    render(data);
  } catch (err) {
    renderError(err.message);
  }
}

connectLive();
connectStream();
