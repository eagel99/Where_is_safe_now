const state = {
  health: null,
  active: { status: 'clear', areas: [], activeCount: 0, preAlertCount: 0 },
  events: [],
  sources: new Map(),
  actions: { enabled: false, recentDeliveries: [] },
  connected: false,
  soundEnabled: false,
  map: null,
  mapLayer: null,
  geoJson: null,
};

const elements = Object.fromEntries([
  'connectionText', 'clock', 'soundButton', 'threatBanner', 'threatLabel', 'threatTitle',
  'threatInstruction', 'activeAreaCount', 'healthMode', 'healthNote', 'healthySources',
  'eventCount', 'actionMode', 'actionCount', 'activeAreas', 'stateUpdated', 'timeline',
  'timelineFilter', 'sources', 'deliveries', 'fitMapButton', 'mapFallback',
].map((id) => [id, document.getElementById(id)]));

const labels = {
  clear: 'אין איום פעיל',
  alert: 'איום פעיל',
  pre_alert: 'התרעה מקדימה',
  end: 'האירוע הסתיים',
};
const sourceLabels = {
  'tzevaadom-ws': 'צבע אדום WebSocket',
  'oref-mobile-pushy': 'ערוץ Push של האפליקציה',
  'oref-realtime': 'פיקוד העורף בזמן אמת',
  'oref-history': 'היסטוריית פיקוד העורף',
  'oref-extended-history': 'היסטוריה מורחבת',
  'manual-test': 'בדיקת מערכת',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function time(value, withDate = false) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return parsed.toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
  });
}

function sourceHealthy(source) {
  if (source.state === 'connected') return true;
  if (source.state !== 'polling' || !source.lastSuccessAt) return false;
  const maxAge = Math.max((source.intervalMs || 1000) * 5, 15000);
  return Date.now() - Date.parse(source.lastSuccessAt) < maxAge;
}

function statusClass(source) {
  if (sourceHealthy(source)) return 'healthy';
  if (['starting', 'connecting', 'reconnecting', 'polling'].includes(source.state)) return 'pending';
  return 'failed';
}

function renderBanner() {
  const current = state.active.areas[0] || null;
  const status = current?.kind || 'clear';
  elements.threatBanner.className = `threat-banner ${status}`;
  elements.threatLabel.textContent = labels[status] || labels.clear;
  elements.threatTitle.textContent = current?.title || 'המערכת ממתינה להתראות';
  elements.threatInstruction.textContent = current?.instructions || 'יש לפעול תמיד לפי הנחיות פיקוד העורף הרשמיות.';
  elements.activeAreaCount.textContent = state.active.activeCount + state.active.preAlertCount;
  document.title = status === 'alert' ? `התראה: ${current?.area || ''}` : 'מרכז התרעות בזמן אמת';
}

function renderMetrics() {
  const sources = [...state.sources.values()];
  const healthy = sources.filter(sourceHealthy).length;
  const mode = state.health?.mode || 'בודק';
  elements.healthMode.textContent = {
    'fast-and-verified': 'מהיר ומאומת',
    'official-only': 'רשמי בלבד',
    'recovery-only': 'שחזור בלבד',
    degraded: 'מצב חלקי',
  }[mode] || 'בודק';
  elements.healthNote.textContent = state.connected ? 'חיבור חי לשרת פעיל' : 'מנסה להתחבר מחדש';
  elements.healthySources.textContent = `${healthy}/${sources.length}`;
  elements.eventCount.textContent = state.events.length;
  elements.actionMode.textContent = state.actions.enabled ? 'פעילות' : 'כבויות';
  elements.actionCount.textContent = `${state.actions.recentDeliveries?.length || 0} מסירות אחרונות`;
}

function renderActiveAreas() {
  elements.stateUpdated.textContent = state.active.updatedAt ? `עודכן ${time(state.active.updatedAt)}` : '';
  if (!state.active.areas.length) {
    elements.activeAreas.innerHTML = '<p class="empty-state">אין כרגע אזורים במצב התרעה.</p>';
    return;
  }
  elements.activeAreas.innerHTML = state.active.areas.map((item) => `
    <div class="area-item">
      <span class="kind-dot ${escapeHtml(item.kind)}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(item.area)}</strong>
        <small>${escapeHtml(item.title)}${item.detail?.zone ? ` · ${escapeHtml(item.detail.zone)}` : ''}</small>
      </div>
      <span class="countdown">${item.detail?.countdown ? `${escapeHtml(item.detail.countdown)} שנ׳` : time(item.occurredAt)}</span>
    </div>
  `).join('');
}

function eventLatency(event) {
  const latency = Date.parse(event.firstSeenAt || event.receivedAt) - Date.parse(event.occurredAt);
  return Number.isFinite(latency) && latency >= 0 && latency < 3600000 ? `${latency}ms` : '';
}

function renderTimeline() {
  const filter = elements.timelineFilter.value;
  const events = state.events.filter((event) => filter === 'all' || event.kind === filter).slice(0, 150);
  if (!events.length) {
    elements.timeline.innerHTML = '<p class="empty-state">עדיין לא נקלטו אירועים.</p>';
    return;
  }
  elements.timeline.innerHTML = events.map((event) => `
    <article class="timeline-item" data-event-id="${escapeHtml(event.eventId)}">
      <time class="timeline-time">${time(event.occurredAt, true)}</time>
      <div class="timeline-content">
        <div class="timeline-title">
          <span class="badge ${escapeHtml(event.kind)}">${escapeHtml(labels[event.kind] || event.kind)}</span>
          <strong>${escapeHtml(event.title)}</strong>
        </div>
        <p class="timeline-areas">${escapeHtml(event.areas.join(', '))}</p>
        <p class="timeline-meta">${escapeHtml(event.sources.map((source) => sourceLabels[source] || source).join(' + '))}${eventLatency(event) ? ` · ${eventLatency(event)}` : ''}</p>
      </div>
    </article>
  `).join('');
}

function renderSources() {
  const sources = [...state.sources.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!sources.length) {
    elements.sources.innerHTML = '<p class="empty-state">אין נתוני מקור.</p>';
    return;
  }
  elements.sources.innerHTML = sources.map((source) => `
    <div class="source-row">
      <span class="source-status ${statusClass(source)}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(sourceLabels[source.name] || source.name)}</strong>
        <small>${escapeHtml(source.role || '')}${source.latencyMs != null ? ` · ${escapeHtml(source.latencyMs)}ms` : ''}</small>
      </div>
      <small>${escapeHtml(source.state)}</small>
    </div>
  `).join('');
}

function renderDeliveries() {
  const deliveries = state.actions.recentDeliveries || [];
  if (!deliveries.length) {
    elements.deliveries.innerHTML = `<p class="empty-state">${state.actions.enabled ? 'אין עדיין מסירות.' : 'מנוע הפעולות כבוי כברירת מחדל.'}</p>`;
    return;
  }
  elements.deliveries.innerHTML = deliveries.slice(0, 15).map((delivery) => `
    <div class="delivery-row">
      <span class="source-status ${delivery.status === 'delivered' ? 'healthy' : 'failed'}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(delivery.ruleId)} · ${escapeHtml(delivery.actionType)}</strong>
        <small>${time(delivery.completedAt || delivery.startedAt, true)} · ${escapeHtml(delivery.attempts || 0)} ניסיונות</small>
      </div>
      <span class="delivery-result ${escapeHtml(delivery.status)}">${escapeHtml(delivery.status)}</span>
    </div>
  `).join('');
}

function colorForKind(kind) {
  return kind === 'alert' ? '#ed4d59' : kind === 'pre_alert' ? '#f1a63b' : '#6685ad';
}

function initMap() {
  if (!window.L) {
    document.getElementById('map').innerHTML = '<p class="empty-state">Leaflet לא נטען. יש להריץ npm install.</p>';
    return;
  }
  state.map = L.map('map', { zoomControl: true }).setView([31.5, 34.8], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    referrerPolicy: 'strict-origin-when-cross-origin',
    updateWhenIdle: true,
    keepBuffer: 2,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(state.map);
  state.mapLayer = L.layerGroup().addTo(state.map);
}

function featureAreaName(feature) {
  const properties = feature?.properties || {};
  return properties.name || properties.area || properties.city || properties['שם'] || properties['שם_ישוב'] || '';
}

function renderMap(fit = false) {
  if (!state.mapLayer) return;
  state.mapLayer.clearLayers();
  const activeByArea = new Map(state.active.areas.map((item) => [item.area, item]));
  if (state.geoJson?.features?.length) {
    L.geoJSON(state.geoJson, {
      style: (feature) => {
        const item = activeByArea.get(featureAreaName(feature));
        return {
          color: item ? colorForKind(item.kind) : '#52606d',
          fillColor: item ? colorForKind(item.kind) : '#18212b',
          fillOpacity: item ? .34 : .04,
          weight: item ? 2.5 : 1,
        };
      },
      onEachFeature: (feature, layer) => {
        const name = featureAreaName(feature);
        if (name) layer.bindTooltip(escapeHtml(name));
      },
    }).addTo(state.mapLayer);
  }
  const points = [];
  for (const item of state.active.areas) {
    const lat = Number(item.detail?.lat);
    const lng = Number(item.detail?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    points.push([lat, lng]);
    L.circleMarker([lat, lng], {
      radius: item.kind === 'alert' ? 10 : 8,
      color: colorForKind(item.kind),
      fillColor: colorForKind(item.kind),
      fillOpacity: .6,
      weight: 3,
    }).bindPopup(`<strong>${escapeHtml(item.area)}</strong><br>${escapeHtml(item.title)}<br>${escapeHtml(item.instructions || '')}`).addTo(state.mapLayer);
  }
  elements.mapFallback.classList.toggle('hidden', points.length > 0 || state.active.areas.length === 0);
  if ((fit || points.length === 1) && points.length) {
    if (points.length === 1) state.map.setView(points[0], 11);
    else state.map.fitBounds(points, { padding: [35, 35], maxZoom: 11 });
  }
}

function renderAll() {
  renderBanner();
  renderMetrics();
  renderActiveAreas();
  renderTimeline();
  renderSources();
  renderDeliveries();
  renderMap();
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function initialLoad() {
  const [health, active, events, sources, actions, geoJson] = await Promise.all([
    getJson('/api/v1/health').catch(() => null),
    getJson('/api/v1/state'),
    getJson('/api/v1/alerts?limit=300'),
    getJson('/api/v1/sources'),
    getJson('/api/v1/actions'),
    getJson('/api/v1/geojson').catch(() => ({ type: 'FeatureCollection', features: [] })),
  ]);
  state.health = health;
  state.active = active;
  state.events = events;
  state.sources = new Map(sources.map((source) => [source.name, source]));
  state.actions = actions;
  state.geoJson = geoJson;
  renderAll();
  renderMap(true);
}

function upsertEvent(event) {
  const index = state.events.findIndex((item) => item.eventId === event.eventId);
  if (index >= 0) state.events[index] = event;
  else state.events.unshift(event);
  state.events = state.events.slice(0, 1000);
}

function playAlertSound(kind) {
  if (!state.soundEnabled || !['alert', 'pre_alert'].includes(kind)) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = kind === 'alert' ? 880 : 620;
  gain.gain.setValueAtTime(.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.18, context.currentTime + .02);
  gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .55);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + .6);
}

function connectEvents() {
  const events = new EventSource('/api/v1/events');
  events.addEventListener('connected', (message) => {
    state.connected = true;
    elements.connectionText.textContent = 'מחובר לעדכונים חיים';
    const payload = JSON.parse(message.data);
    if (payload.state) state.active = payload.state;
    if (payload.health) state.health = payload.health;
    renderAll();
  });
  events.addEventListener('alert', (message) => {
    const event = JSON.parse(message.data);
    upsertEvent(event);
    playAlertSound(event.kind);
    renderTimeline();
    renderMetrics();
  });
  events.addEventListener('alert-update', (message) => {
    upsertEvent(JSON.parse(message.data));
    renderTimeline();
  });
  events.addEventListener('state', (message) => {
    state.active = JSON.parse(message.data);
    renderBanner();
    renderActiveAreas();
    renderMap(true);
  });
  events.addEventListener('source-status', (message) => {
    const source = JSON.parse(message.data);
    state.sources.set(source.name, source);
    renderSources();
    renderMetrics();
  });
  events.addEventListener('action-delivery', (message) => {
    const delivery = JSON.parse(message.data);
    state.actions.recentDeliveries = [delivery, ...(state.actions.recentDeliveries || [])].slice(0, 50);
    renderDeliveries();
    renderMetrics();
  });
  events.onerror = () => {
    state.connected = false;
    elements.connectionText.textContent = 'החיבור נותק, מנסה להתחבר מחדש';
    renderMetrics();
  };
}

function setupControls() {
  elements.timelineFilter.addEventListener('change', renderTimeline);
  elements.fitMapButton.addEventListener('click', () => renderMap(true));
  elements.soundButton.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    elements.soundButton.setAttribute('aria-pressed', String(state.soundEnabled));
    elements.soundButton.textContent = state.soundEnabled ? 'צליל פעיל' : 'הפעל צליל';
    if (state.soundEnabled) playAlertSound('pre_alert');
  });
}

function updateClock() {
  elements.clock.textContent = new Date().toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

initMap();
setupControls();
updateClock();
setInterval(updateClock, 1000);
initialLoad().catch((error) => {
  elements.connectionText.textContent = `לא ניתן לטעון את המערכת: ${error.message}`;
});
connectEvents();
