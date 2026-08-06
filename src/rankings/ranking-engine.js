import { EventEmitter } from 'node:events';
import { DistrictCatalog, normalizeLabel } from './area-catalog-source.js';

// Historical ranking of areas by missile/UAV alerts over a rolling window.
// This is the statistics half of the app: it answers "where have sirens sounded
// this week", not "is there an alert right now" — the live sources under
// src/sources do that.
//
// The history endpoint's per-city filter (mode=2 with city_0) no longer returns
// anything, for any spelling or identifier, so the whole window is pulled with
// the unfiltered mode=0 query and aggregated here. That is also one request
// instead of hundreds.

const API_BASE = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';

// The endpoint truncates at 3000 rows, newest first, whatever the range.
export const RESPONSE_ROW_CAP = 3000;

const BROWSER_HEADERS = {
  Referer: 'https://alerts-history.oref.org.il/12481-he/Pakar.aspx',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept-Language': 'he-IL,he;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://alerts-history.oref.org.il',
};

const CATEGORY_MISSILES = 1;
const CATEGORY_UAV = 2;
export const ALERT_CATEGORIES = new Set([CATEGORY_MISSILES, CATEGORY_UAV]);

export function fmt(date) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

export function safeParseJSON(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  // Drop prototype pollution attempts (own properties only)
  return parsed.filter(
    (item) =>
      item != null &&
      typeof item === 'object' &&
      !Object.hasOwn(item, '__proto__') &&
      !Object.hasOwn(item, 'constructor'),
  );
}

export function normalizeCity(name) {
  const normalized = normalizeLabel(name);
  return normalized || 'Unknown';
}

/** Splits a window into whole days, newest first. */
export function dayRange(from, to) {
  const days = [];
  const cursor = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  const first = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor >= first) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return days;
}

/**
 * Counts rows into per-area totals. Rows are de-duplicated by `rid` because a
 * day-by-day fallback can overlap with the window query.
 */
export function tallyRows(rows, { cutoff, seen = new Set(), counts = new Map() } = {}) {
  for (const row of rows) {
    if (!row || seen.has(row.rid)) continue;
    seen.add(row.rid);
    if (!ALERT_CATEGORIES.has(Number(row.category))) continue;
    const at = Date.parse(row.alertDate);
    if (Number.isFinite(cutoff) && Number.isFinite(at) && at < cutoff) continue;
    const area = normalizeCity(row.data);
    counts.set(area, (counts.get(area) || 0) + 1);
  }
  return { counts, seen };
}

/**
 * Rolls per-area counts up to base cities and builds the ranking payload.
 *
 * Sub-region counts merge into their base city by **max**, not sum, so a city
 * split into many zones is not double-counted. `allCities` lists every known
 * base city including those with no alerts, so the city picker covers the whole
 * country; `most` and `least` only rank cities that were actually hit.
 */
export function computeRankings(areaCounts, options) {
  const {
    baseCityOf = (label) => label,
    baseCities = [],
    fromDate,
    toDate,
    updatedAt,
    truncated = false,
    areasKnown = 0,
  } = options;

  const counts = areaCounts instanceof Map ? areaCounts : new Map(Object.entries(areaCounts || {}));

  const baseCityCounts = new Map();
  for (const city of baseCities) baseCityCounts.set(city, 0);
  for (const [area, count] of counts) {
    const base = baseCityOf(area);
    baseCityCounts.set(base, Math.max(baseCityCounts.get(base) || 0, count));
  }

  const sorted = [...baseCityCounts.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, 'he'));

  const hit = sorted.filter((entry) => entry.count > 0);
  const most = hit.slice(0, 3);
  const least = hit.length > 3 ? hit.slice(-3).reverse() : hit.slice().reverse();
  let totalAlerts = 0;
  for (const count of counts.values()) totalAlerts += count;

  return {
    most,
    least,
    allCities: sorted,
    totalAlerts,
    totalCities: hit.length,
    areasKnown,
    truncated,
    fromDate,
    toDate,
    updatedAt,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emits `progress`, `update` and `done` — the same event names the dashboard's
 * SSE stream exposes, so the browser contract is unchanged.
 */
export class RankingEngine extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger;
    this.catalog = new DistrictCatalog({ config, logger });
    this.cache = null;
    this.cacheTime = 0;
    this.queryPromise = null;
    this.refreshTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    void this.autoRefreshLoop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.refreshTimer);
  }

  isFresh() {
    return Boolean(this.cache) && Date.now() - this.cacheTime < this.config.rankingCacheTtlMs;
  }

  async autoRefreshLoop() {
    while (!this.stopped) {
      try {
        await this.get();
      } catch (error) {
        this.logger.error({ err: error.message }, 'Ranking refresh failed');
      }
      await new Promise((resolve) => {
        this.refreshTimer = setTimeout(resolve, this.config.rankingCacheTtlMs);
        this.refreshTimer.unref?.();
      });
    }
  }

  /** Cached result, or the in-flight query — never two concurrent scans. */
  async get() {
    if (this.isFresh()) return this.cache;
    if (this.queryPromise) return this.queryPromise;

    this.queryPromise = this.runQuery();
    try {
      return await this.queryPromise;
    } finally {
      this.queryPromise = null;
    }
  }

  /** Kick off a scan without waiting, so an SSE client can subscribe to it. */
  ensureQueryRunning() {
    if (this.queryPromise || this.isFresh()) return;
    this.queryPromise = this.runQuery();
    this.queryPromise.finally(() => {
      this.queryPromise = null;
    });
  }

  async apiFetch(fromDate, toDate) {
    const params = `lang=he&fromDate=${fromDate}&toDate=${toDate}&mode=0`;
    try {
      const response = await fetch(`${API_BASE}?${params}`, { headers: BROWSER_HEADERS });
      if (!response.ok) return [];
      return safeParseJSON(await response.text());
    } catch (error) {
      this.logger.warn({ err: error.message, fromDate, toDate }, 'History request failed');
      return [];
    }
  }

  async runQuery() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.config.rankingWindowDays * 24 * 60 * 60 * 1000);
    const fromDate = fmt(windowStart);
    const toDate = fmt(now);
    const cutoff = windowStart.getTime();
    const updatedAt = now.toISOString();

    await this.catalog.load();
    const context = {
      baseCityOf: (label) => this.catalog.baseCityOf(label),
      baseCities: this.catalog.baseCities,
      areasKnown: this.catalog.entries.length,
      fromDate,
      toDate,
      updatedAt,
    };

    this.logger.info(
      { fromDate, toDate, areas: context.areasKnown, catalog: this.catalog.source },
      'Ranking scan started',
    );

    // One request covers the whole window unless the row cap truncates it.
    this.emit('progress', { done: 0, total: 1, label: `${fromDate} – ${toDate}`, city: toDate });
    const windowRows = await this.apiFetch(fromDate, toDate);
    let { counts, seen } = tallyRows(windowRows, { cutoff });
    let truncated = false;

    if (windowRows.length >= RESPONSE_ROW_CAP) {
      // The endpoint returned its maximum, so older days in the window were cut
      // off. Re-walk it a day at a time; each day gets its own 3000-row budget.
      const days = dayRange(windowStart, now);
      this.logger.warn(
        { rows: windowRows.length, days: days.length },
        'History response hit the row cap, falling back to per-day queries',
      );

      for (const [index, day] of days.entries()) {
        const label = fmt(day);
        const rows = await this.apiFetch(label, label);
        if (rows.length >= RESPONSE_ROW_CAP) truncated = true;
        ({ counts, seen } = tallyRows(rows, { cutoff, seen, counts }));

        this.emit('progress', { done: index + 1, total: days.length, label, city: label });
        this.emit('update', computeRankings(counts, { ...context, truncated }));
        if (index < days.length - 1) await delay(this.config.rankingRequestDelayMs);
      }
    } else {
      this.emit('progress', { done: 1, total: 1, label: `${fromDate} – ${toDate}`, city: toDate });
    }

    const result = computeRankings(counts, { ...context, truncated });
    this.cache = result;
    this.cacheTime = Date.now();
    this.emit('done', result);

    this.logger.info(
      {
        totalAlerts: result.totalAlerts,
        citiesHit: result.totalCities,
        areasKnown: result.areasKnown,
        truncated,
      },
      'Ranking scan finished',
    );

    return result;
  }
}
