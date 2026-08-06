import test from 'node:test';
import assert from 'node:assert/strict';
import { eventMatchesRule, interpolateTemplate } from '../src/actions/action-matcher.js';

const event = {
  eventId: 'abc', kind: 'alert', category: 1, threat: 'missiles', severity: 3,
  title: 'ירי רקטות וטילים', instructions: 'היכנסו למרחב המוגן',
  areas: ['באר שבע - דרום'], areaIds: ['123'], sources: ['fast', 'official'],
  primarySource: 'fast', occurredAt: '2026-08-06T09:00:00Z', receivedAt: '2026-08-06T09:00:01Z',
};

test('matches wildcard areas and source constraints', () => {
  assert.equal(eventMatchesRule(event, { match: { kinds: ['alert'], areas: ['באר שבע*'], sources: ['official'] } }), true);
  assert.equal(eventMatchesRule(event, { match: { excludeAreas: ['באר שבע*'] } }), false);
});

test('test events require explicit opt-in', () => {
  assert.equal(eventMatchesRule({ ...event, test: true }, { match: {} }), false);
  assert.equal(eventMatchesRule({ ...event, test: true }, { match: { allowTest: true } }), true);
});

test('interpolates approved event fields without evaluation', () => {
  assert.deepEqual(interpolateTemplate({ id: '{{event.eventId}}', areas: '{{event.areas}}' }, event), {
    id: 'abc', areas: 'באר שבע - דרום',
  });
});
