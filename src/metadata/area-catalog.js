import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { normalizeAreaName } from '../core/normalize.js';

function collectSegments(value, result = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSegments(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  const id = value.segment ?? value.segmentId ?? value.id ?? value.segment_id;
  const name = value.name ?? value.label ?? value.description ?? value.title;
  if ((typeof id === 'number' || /^\d+$/.test(String(id ?? ''))) && typeof name === 'string') {
    result.set(String(id), normalizeAreaName(name));
  }
  for (const child of Object.values(value)) collectSegments(child, result);
  return result;
}

export class AreaCatalog {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.byName = new Map();
    this.segmentToArea = new Map();
    this.areaToSegment = new Map();
    this.cacheFile = path.join(config.dataDir, 'segments.json');
  }

  async init() {
    await this.loadCityMetadata();
    await this.loadCachedSegments();
    if (this.config.enablePushy) await this.refreshSegments();
  }

  // Vendored from eladnava/pikud-haoref-api (Apache-2.0) — see
  // THIRD_PARTY_NOTICES.md. Reading the data file directly keeps the geo
  // metadata without pulling that package's abandoned `request` dependency
  // tree, which carries unpatched critical advisories.
  async loadCityMetadata() {
    try {
      const cities = JSON.parse(await fs.readFile(this.config.citiesMetadataFile, 'utf8'));
      for (const city of cities) {
        if (!city?.name || city.value === 'all') continue;
        const name = normalizeAreaName(city.name);
        this.byName.set(name, {
          area: name,
          lat: Number(city.lat) || null,
          lng: Number(city.lng) || null,
          countdown: Number(city.countdown) || 0,
          zone: city.zone || '',
          nameEn: city.name_en || '',
          nameAr: city.name_ar || '',
          nameRu: city.name_ru || '',
        });
      }
    } catch (error) {
      this.logger.warn({ err: error.message, file: this.config.citiesMetadataFile }, 'Could not load city metadata');
    }
  }

  async loadCachedSegments() {
    try {
      const cached = JSON.parse(await fs.readFile(this.cacheFile, 'utf8'));
      this.applySegments(new Map(cached.entries || []));
    } catch {
      // Cache is optional.
    }
  }

  async refreshSegments() {
    try {
      const response = await axios.get(this.config.pushySegmentsUrl, {
        timeout: this.config.requestTimeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrefCommandCenter/2.0)' },
      });
      const segments = collectSegments(response.data);
      if (!segments.size) throw new Error('No segment records found');
      this.applySegments(segments);
      await fs.writeFile(this.cacheFile, JSON.stringify({ updatedAt: new Date().toISOString(), entries: [...segments] }, null, 2));
    } catch (error) {
      this.logger.warn({ err: error.message }, 'Could not refresh Oref segment metadata, using cached/package data');
    }
  }

  applySegments(segments) {
    for (const [id, rawName] of segments) {
      const name = normalizeAreaName(rawName);
      this.segmentToArea.set(String(id), name);
      if (!this.areaToSegment.has(name)) this.areaToSegment.set(name, String(id));
    }
  }

  get(area) {
    return this.byName.get(normalizeAreaName(area)) || null;
  }

  detailsFor(areas) {
    return areas.map((area) => this.get(area) || { area, lat: null, lng: null, countdown: 0, zone: '' });
  }

  segmentIdsForAreas(areas) {
    return areas.map((area) => this.areaToSegment.get(normalizeAreaName(area))).filter(Boolean);
  }

  allSegmentIds() {
    return [...this.segmentToArea.keys()];
  }
}
