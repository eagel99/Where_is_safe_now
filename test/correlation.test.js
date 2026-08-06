import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateMatchesEvent, createEvent, mergeCandidate } from '../src/core/correlation.js';
import { makeCandidate } from '../src/core/normalize.js';

const occurredAt = '2026-08-06T09:00:00.000Z';

test('correlates matching alerts from different sources and merges provenance', () => {
  const first = makeCandidate({ source: 'fast', rawId: 'a', category: 1, areas: ['אופקים'], occurredAt });
  const second = makeCandidate({ source: 'official', rawId: 'b', category: 1, areas: ['אופקים', 'מרחבים'], occurredAt });
  const event = createEvent(first);
  assert.equal(candidateMatchesEvent(second, event, 30000), true);
  assert.equal(mergeCandidate(event, second), true);
  assert.deepEqual(event.sources, ['fast', 'official']);
  assert.deepEqual(event.areas, ['אופקים', 'מרחבים']);
});

test('does not correlate different threat categories', () => {
  const first = makeCandidate({ source: 'a', category: 1, areas: ['אופקים'], occurredAt });
  const second = makeCandidate({ source: 'b', category: 2, areas: ['אופקים'], occurredAt });
  assert.equal(candidateMatchesEvent(second, createEvent(first), 30000), false);
});

test('does not merge unrelated unlocalized candidates or test and live events', () => {
  const first = makeCandidate({ source: 'a', category: 14, areaIds: ['1'], occurredAt });
  const unrelated = makeCandidate({ source: 'b', category: 14, areaIds: ['2'], occurredAt });
  const testCandidate = makeCandidate({ source: 'b', category: 14, areaIds: ['1'], occurredAt, test: true });
  const event = createEvent(first);
  assert.equal(candidateMatchesEvent(unrelated, event, 30000), false);
  assert.equal(candidateMatchesEvent(testCandidate, event, 30000), false);
});
