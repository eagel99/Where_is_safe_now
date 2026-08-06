import crypto from 'node:crypto';
import { jaccard } from './normalize.js';

export function createEvent(candidate) {
  const bucket = Math.floor(Date.parse(candidate.occurredAt) / 10_000);
  const base = [candidate.test ? 'test' : 'live', candidate.kind, candidate.category, bucket, [...candidate.areas].sort().join('|')].join('::');
  return {
    eventId: crypto.createHash('sha256').update(base).digest('hex').slice(0, 24),
    kind: candidate.kind,
    category: candidate.category,
    threat: candidate.threat,
    severity: candidate.severity,
    title: candidate.title,
    instructions: candidate.instructions,
    areas: [...candidate.areas],
    areaIds: [...candidate.areaIds],
    areaDetails: [],
    sources: [candidate.source],
    rawIds: candidate.rawId ? { [candidate.source]: [candidate.rawId] } : {},
    candidates: [candidate.candidateId],
    occurredAt: candidate.occurredAt,
    receivedAt: candidate.receivedAt,
    firstSeenAt: candidate.receivedAt,
    lastSeenAt: candidate.receivedAt,
    rawSamples: candidate.raw == null ? {} : { [candidate.source]: candidate.raw },
    test: candidate.test === true,
  };
}

export function candidateMatchesEvent(candidate, event, windowMs) {
  if (candidate.kind !== event.kind || candidate.category !== event.category) return false;
  if (Boolean(candidate.test) !== Boolean(event.test)) return false;
  const timeDistance = Math.abs(Date.parse(candidate.occurredAt) - Date.parse(event.occurredAt));
  if (timeDistance > windowMs) return false;

  if (candidate.rawId && event.rawIds[candidate.source]?.includes(candidate.rawId)) return true;

  const areaScore = candidate.areas.length && event.areas.length ? jaccard(candidate.areas, event.areas) : 0;
  const idScore = candidate.areaIds.length && event.areaIds.length ? jaccard(candidate.areaIds, event.areaIds) : 0;
  const anyAreaOverlap = candidate.areas.some((area) => event.areas.includes(area));
  const anyIdOverlap = candidate.areaIds.some((id) => event.areaIds.includes(id));
  return areaScore >= 0.25 || idScore >= 0.25 || anyAreaOverlap || anyIdOverlap;
}

export function mergeCandidate(event, candidate) {
  const before = JSON.stringify({
    areas: event.areas,
    areaIds: event.areaIds,
    sources: event.sources,
    title: event.title,
    instructions: event.instructions,
  });

  event.areas = [...new Set([...event.areas, ...candidate.areas])];
  event.areaIds = [...new Set([...event.areaIds, ...candidate.areaIds])];
  event.sources = [...new Set([...event.sources, candidate.source])];
  event.candidates = [...new Set([...event.candidates, candidate.candidateId])];
  event.lastSeenAt = candidate.receivedAt;
  if (Date.parse(candidate.occurredAt) < Date.parse(event.occurredAt)) event.occurredAt = candidate.occurredAt;
  if (candidate.instructions.length > event.instructions.length) event.instructions = candidate.instructions;
  if (candidate.title.length > event.title.length) event.title = candidate.title;
  if (candidate.rawId) {
    event.rawIds[candidate.source] = [...new Set([...(event.rawIds[candidate.source] || []), candidate.rawId])];
  }
  event.test = event.test || candidate.test === true;
  if (candidate.raw != null && event.rawSamples[candidate.source] == null) {
    event.rawSamples[candidate.source] = candidate.raw;
  }

  const after = JSON.stringify({
    areas: event.areas,
    areaIds: event.areaIds,
    sources: event.sources,
    title: event.title,
    instructions: event.instructions,
  });
  return before !== after;
}
