import crypto from 'node:crypto';
import { categoryMetadata, kindFromHistoryCategory } from './categories.js';

const punctuation = /[\u2010-\u2015]/g;

export function normalizeAreaName(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(punctuation, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanAreas(values, includeDrills = false) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const area = normalizeAreaName(raw);
    if (!area || (!includeDrills && area.includes('בדיקה')) || seen.has(area)) continue;
    seen.add(area);
    result.push(area);
  }
  return result;
}

export function parseOccurredAt(value, fallback = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'number') {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

export function makeCandidate(input, { includeDrills = false } = {}) {
  const category = Number.isFinite(Number(input.category)) ? Number(input.category) : 4;
  const metadata = categoryMetadata(category);
  const kind = input.kind || kindFromHistoryCategory(category);
  const source = String(input.source || 'unknown');
  const receivedAt = new Date().toISOString();
  const occurredAt = parseOccurredAt(input.occurredAt, new Date(receivedAt));
  const areas = cleanAreas(input.areas, includeDrills);
  const areaIds = [...new Set((Array.isArray(input.areaIds) ? input.areaIds : [])
    .map((item) => String(item).trim())
    .filter(Boolean))];
  const rawId = String(input.rawId || '');
  const candidateBase = [source, rawId, category, kind, occurredAt, areas.join('|'), areaIds.join('|')].join('::');

  return {
    candidateId: crypto.createHash('sha256').update(candidateBase).digest('hex').slice(0, 24),
    source,
    rawId,
    kind,
    category,
    threat: metadata.threat,
    severity: metadata.severity,
    title: String(input.title || metadata.label),
    instructions: String(input.instructions || ''),
    areas,
    areaIds,
    occurredAt,
    receivedAt,
    raw: input.raw ?? null,
    test: Boolean(input.test || input.raw?.test),
  };
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function passesAreaFilter(candidate, filter) {
  if (!filter.length) return true;
  const normalized = new Set(filter.map(normalizeAreaName));
  return candidate.areas.some((area) => normalized.has(normalizeAreaName(area)));
}

export function extractInstructionSeconds(text = '') {
  const minutes = String(text).match(/(\d+)\s*דקות?/);
  if (minutes) return Number(minutes[1]) * 60;
  const seconds = String(text).match(/(\d+)\s*שניות?/);
  if (seconds) return Number(seconds[1]);
  return null;
}
