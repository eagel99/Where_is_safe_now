import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRealtimeCategory } from '../src/core/categories.js';
import { cleanAreas, extractInstructionSeconds, makeCandidate, normalizeAreaName } from '../src/core/normalize.js';

test('normalizes punctuation, whitespace and duplicate areas', () => {
  assert.equal(normalizeAreaName('  באר שבע – דרום  '), 'באר שבע - דרום');
  assert.deepEqual(cleanAreas(['אופקים', ' אופקים ', 'בדיקה']), ['אופקים']);
});

test('classifies realtime informational messages', () => {
  assert.deepEqual(classifyRealtimeCategory(10, 'בדקות הקרובות צפויות להתקבל התרעות'), { category: 14, kind: 'pre_alert' });
  assert.deepEqual(classifyRealtimeCategory(10, 'האירוע הסתיים'), { category: 13, kind: 'end' });
  assert.deepEqual(classifyRealtimeCategory(1), { category: 1, kind: 'alert' });
});

test('extracts instruction timing', () => {
  assert.equal(extractInstructionSeconds('יש להישאר 10 דקות במרחב המוגן'), 600);
  assert.equal(extractInstructionSeconds('היכנסו בתוך 45 שניות'), 45);
});

test('creates a stable normalized candidate', () => {
  const candidate = makeCandidate({
    source: 'test', rawId: '1', category: 1, areas: ['אופקים'], occurredAt: 1700000000000,
  });
  assert.equal(candidate.kind, 'alert');
  assert.equal(candidate.threat, 'missiles');
  assert.deepEqual(candidate.areas, ['אופקים']);
  assert.equal(candidate.candidateId.length, 24);
});
