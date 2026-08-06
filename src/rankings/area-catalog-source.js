import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

// The full list of alertable areas, straight from Pikud HaOref. This is the
// same vocabulary the history endpoint reports in its `data` field — including
// villages, kibbutzim and industrial zones — so it replaces the hand-maintained
// 85-city list that covered only a fraction of them.
export const DISTRICTS_URL = 'https://alerts-history.oref.org.il/Shared/Ajax/GetDistricts.aspx';

const REQUEST_HEADERS = {
  Referer: 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9',
  'User-Agent': 'Mozilla/5.0 (compatible; OrefCommandCenter/2.0)',
};

export function normalizeLabel(value) {
  return String(value ?? '')
    .replace(/^﻿/, '')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEntries(rows) {
  const byLabel = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = normalizeLabel(row?.label_he ?? row?.label);
    if (!label || byLabel.has(label)) continue;
    byLabel.set(label, {
      label,
      areaid: Number(row.areaid) || null,
      areaname: normalizeLabel(row.areaname),
      migun_time: Number(row.migun_time) || 0,
    });
  }
  return [...byLabel.values()];
}

/**
 * Derives the base city for an area label using the catalog itself rather than
 * a hardcoded list of compass directions.
 *
 * Sub-region labels look like "אשדוד - ג,ו,ז" or "אשדוד -יא,יב,טו" (the API is
 * inconsistent about the space). An industrial zone reads the other way round:
 * "אזור תעשייה עידן הנגב - להבים". Whichever side is itself a known area label
 * is the base city; if neither is, the label stands on its own.
 */
export function makeBaseCityResolver(labels) {
  const known = labels instanceof Set ? labels : new Set(labels);
  const cache = new Map();

  return function baseCityOf(rawLabel) {
    const label = normalizeLabel(rawLabel);
    if (cache.has(label)) return cache.get(label);

    let base = label;
    const dash = label.indexOf('-');
    if (dash > 0) {
      const left = label.slice(0, dash).trim();
      const right = label.slice(dash + 1).trim();
      if (left && known.has(left)) base = left;
      else if (right && known.has(right)) base = right;
      else if (left) base = left;
    }

    cache.set(label, base);
    return base;
  };
}

export class DistrictCatalog {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.entries = [];
    this.labels = new Set();
    this.baseCityOf = makeBaseCityResolver(this.labels);
    this.baseCities = [];
    this.fetchedAt = 0;
    this.source = 'none';
  }

  get cacheFile() {
    return path.join(this.config.dataDir, 'districts.json');
  }

  isStale() {
    return Date.now() - this.fetchedAt > this.config.districtRefreshMs;
  }

  /**
   * Live list when reachable, otherwise the on-disk cache, otherwise the
   * snapshot bundled with the repo. The ranking must not go blank because the
   * districts endpoint had a bad minute.
   */
  async load({ force = false } = {}) {
    if (this.entries.length && !force && !this.isStale()) return this.entries;

    for (const attempt of [
      { source: 'api', run: () => this.fetchRemote() },
      { source: 'cache', run: () => this.readJson(this.cacheFile) },
      { source: 'bundled', run: () => this.readJson(this.config.districtsFile) },
    ]) {
      try {
        const entries = toEntries(await attempt.run());
        if (!entries.length) throw new Error('No district records found');
        this.apply(entries, attempt.source);
        if (attempt.source === 'api') await this.writeCache(entries);
        return this.entries;
      } catch (error) {
        this.logger.warn({ err: error.message, source: attempt.source }, 'District catalog load failed');
      }
    }

    if (!this.entries.length) throw new Error('No district catalog available from API, cache or bundle');
    return this.entries;
  }

  async fetchRemote() {
    const response = await axios.get(DISTRICTS_URL, {
      params: { lang: 'he', _: Date.now() },
      timeout: this.config.requestTimeoutMs,
      headers: REQUEST_HEADERS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return response.data;
  }

  async readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }

  async writeCache(entries) {
    try {
      const temporary = `${this.cacheFile}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(entries, null, 2));
      await fs.rename(temporary, this.cacheFile);
    } catch (error) {
      this.logger.warn({ err: error.message }, 'Could not cache district catalog');
    }
  }

  apply(entries, source) {
    this.entries = entries;
    this.labels = new Set(entries.map((entry) => entry.label));
    this.baseCityOf = makeBaseCityResolver(this.labels);
    this.baseCities = [...new Set(entries.map((entry) => this.baseCityOf(entry.label)))];
    this.fetchedAt = Date.now();
    this.source = source;
    this.logger.info(
      { source, areas: entries.length, baseCities: this.baseCities.length },
      'District catalog loaded',
    );
  }
}
