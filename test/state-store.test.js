import test from 'node:test';
import assert from 'node:assert/strict';
import { AreaStateStore } from '../src/core/state-store.js';

const config = { alertStateTtlMs: 600000, preAlertStateTtlMs: 1200000, endStateTtlMs: 60000 };

test('active alert has priority over a later pre-alert for the same area', () => {
  const store = new AreaStateStore(config);
  const base = {
    eventId: '1', category: 1, threat: 'missiles', severity: 3, title: 'Alert', instructions: '',
    occurredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), areaDetails: [], areas: ['אופקים'],
  };
  store.apply({ ...base, kind: 'alert' });
  store.apply({ ...base, eventId: '2', kind: 'pre_alert', category: 14, severity: 2 });
  assert.equal(store.snapshot().areas[0].kind, 'alert');
});
