function list(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function anyPatternMatches(values, patterns) {
  if (!patterns.length) return true;
  return values.some((value) => patterns.some((pattern) => wildcardToRegExp(pattern).test(String(value))));
}

export function eventMatchesRule(event, rule) {
  const match = rule.match || {};
  if (match.kinds?.length && !match.kinds.includes(event.kind)) return false;
  if (match.categories?.length && !match.categories.map(Number).includes(Number(event.category))) return false;
  if (match.threats?.length && !match.threats.includes(event.threat)) return false;
  if (Number.isFinite(Number(match.minSeverity)) && event.severity < Number(match.minSeverity)) return false;
  if (match.primarySources?.length && !match.primarySources.includes(event.primarySource)) return false;
  if (match.sources?.length && !event.sources.some((source) => match.sources.includes(source))) return false;
  if (match.excludeAreas?.length && anyPatternMatches(event.areas, match.excludeAreas)) return false;
  if (match.areas?.length && !anyPatternMatches(event.areas, match.areas)) return false;
  if (match.areaIds?.length && !event.areaIds.some((id) => match.areaIds.map(String).includes(String(id)))) return false;
  if (event.test && match.allowTest !== true) return false;
  return true;
}

export function interpolateTemplate(value, event) {
  const values = {
    eventId: event.eventId,
    kind: event.kind,
    category: String(event.category),
    threat: event.threat,
    title: event.title,
    instructions: event.instructions,
    areas: event.areas.join(', '),
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    primarySource: event.primarySource,
  };

  if (typeof value === 'string') {
    return value.replace(/\{\{event\.([a-zA-Z]+)\}\}/g, (_match, key) => values[key] ?? '');
  }
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, event));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateTemplate(item, event)]));
  }
  return value;
}

export function normalizeRules(document) {
  return list(document?.rules).filter((rule) => rule && typeof rule === 'object' && rule.id);
}
