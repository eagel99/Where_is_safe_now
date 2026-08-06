import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths resolve against the project root rather than the working directory, so
// the app behaves identically whether it is started from the repo root, from a
// service manager, or from the container's WORKDIR.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fromRoot(value, fallback) {
  return path.resolve(projectRoot, value || fallback);
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function int(name, fallback, min = 0) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  port: int('PORT', 3000, 1),
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir: fromRoot(process.env.DATA_DIR, './.data'),
  publicDir: fromRoot(null, './public'),
  timezone: process.env.TIMEZONE || 'Asia/Jerusalem',
  areaFilter: list('AREA_FILTER'),
  includeDrills: bool('INCLUDE_DRILLS', false),

  orefPollMs: int('OREF_POLL_MS', 1000, 800),
  orefHistoryMs: int('OREF_HISTORY_MS', 10000, 3000),
  orefExtendedHistoryMs: int('OREF_EXTENDED_HISTORY_MS', 60000, 15000),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 3500, 1000),

  enableTzevaAdom: bool('ENABLE_TZEVAADOM', true),
  enablePushy: bool('ENABLE_PUSHY', false),
  pushyAllSegments: bool('PUSHY_ALL_SEGMENTS', true),
  pushySegmentIds: list('PUSHY_SEGMENT_IDS'),
  pushySegmentsUrl:
    process.env.PUSHY_SEGMENTS_URL ||
    'https://dist-android.meser-hadash.org.il/smart-dist/services/anonymous/segments/android?locale=iw_IL&instance=1544803905',
  geoJsonFile: fromRoot(process.env.GEOJSON_FILE, './data/areas.geojson'),
  tzevaAdomIdMapFile: fromRoot(process.env.TZEVAADOM_ID_MAP_FILE, './data/tzevaadom-id-map.json'),
  citiesMetadataFile: fromRoot(process.env.CITIES_METADATA_FILE, './data/cities.json'),

  correlationWindowMs: int('CORRELATION_WINDOW_SECONDS', 30, 5) * 1000,
  recentAlertsLimit: int('RECENT_ALERTS_LIMIT', 1000, 50),
  alertStateTtlMs: int('ALERT_STATE_TTL_SECONDS', 600, 30) * 1000,
  preAlertStateTtlMs: int('PRE_ALERT_STATE_TTL_SECONDS', 1200, 60) * 1000,
  endStateTtlMs: int('END_STATE_TTL_SECONDS', 60, 10) * 1000,
  historyCatchupMs: int('HISTORY_CATCHUP_MINUTES', 5, 1) * 60 * 1000,

  // ── 7-day ranking dashboard ───────────────────────────────────────────
  // The area list comes from the Oref districts endpoint, cached under
  // DATA_DIR, with the bundled snapshot as the last-resort fallback.
  enableRankings: bool('ENABLE_RANKINGS', true),
  districtsFile: fromRoot(process.env.DISTRICTS_FILE, './data/districts.json'),
  districtRefreshMs: int('DISTRICT_REFRESH_HOURS', 24, 1) * 60 * 60 * 1000,
  rankingWindowDays: int('RANKING_WINDOW_DAYS', 7, 1),
  rankingCacheTtlMs: int('RANKING_CACHE_TTL_SECONDS', 120, 30) * 1000,
  rankingRequestDelayMs: int('RANKING_REQUEST_DELAY_MS', 300, 0),

  // ── HTTP hardening ────────────────────────────────────────────────────
  // X-Forwarded-For is client-settable unless a reverse proxy we control
  // rewrites it, so it is only read when TRUST_PROXY says one sits in front.
  trustProxy: bool('TRUST_PROXY', false),
  allowedOrigin: process.env.ALLOWED_ORIGIN || '',
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60000, 1000),
  rateLimitMax: int('RATE_LIMIT_MAX', 60, 1),
  maxSseListeners: int('MAX_SSE_LISTENERS', 100, 1),

  actionsEnabled: bool('ACTIONS_ENABLED', false),
  actionsFile: fromRoot(process.env.ACTIONS_FILE, './config/actions.json'),
  actionAllowedHosts: list('ACTION_ALLOWED_HOSTS').map((host) => host.toLowerCase()),
  actionHmacSecret: process.env.ACTION_HMAC_SECRET || '',
  allowIrreversibleActions: bool('ALLOW_IRREVERSIBLE_ACTIONS', false),
  actionMaxRetries: int('ACTION_MAX_RETRIES', 3, 0),
  actionRequestTimeoutMs: int('ACTION_REQUEST_TIMEOUT_MS', 5000, 1000),
  actionMqttUrl: process.env.ACTION_MQTT_URL || '',
  actionMqttUsername: process.env.ACTION_MQTT_USERNAME || '',
  actionMqttPassword: process.env.ACTION_MQTT_PASSWORD || '',

  enableTestEndpoint: bool('ENABLE_TEST_ENDPOINT', false),
  adminToken: process.env.ADMIN_TOKEN || '',
});
