import { extractInstructionSeconds } from './normalize.js';

export class AreaStateStore {
  constructor(config, onChange) {
    this.config = config;
    this.onChange = onChange;
    this.areas = new Map();
    this.lastSnapshot = '';
  }

  ttlFor(event) {
    if (event.kind === 'pre_alert') return this.config.preAlertStateTtlMs;
    if (event.kind === 'end') return this.config.endStateTtlMs;
    const instructionSeconds = extractInstructionSeconds(event.instructions);
    return instructionSeconds ? Math.max(instructionSeconds * 1000, 60_000) : this.config.alertStateTtlMs;
  }

  apply(event) {
    const now = Date.now();
    const expiresAt = new Date(now + this.ttlFor(event)).toISOString();
    for (const area of event.areas) {
      const current = this.areas.get(area);
      if (event.kind === 'pre_alert' && current?.kind === 'alert' && Date.parse(current.expiresAt) > now) continue;
      this.areas.set(area, {
        area,
        eventId: event.eventId,
        kind: event.kind,
        category: event.category,
        threat: event.threat,
        severity: event.severity,
        title: event.title,
        instructions: event.instructions,
        occurredAt: event.occurredAt,
        updatedAt: event.lastSeenAt,
        expiresAt,
        detail: event.areaDetails.find((item) => item.area === area) || null,
      });
    }
    this.emitIfChanged();
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [area, state] of this.areas.entries()) {
      if (Date.parse(state.expiresAt) <= now) {
        this.areas.delete(area);
        changed = true;
      }
    }
    if (changed) this.emitIfChanged();
  }

  restore(states = []) {
    const now = Date.now();
    for (const state of states) {
      if (state?.area && Date.parse(state.expiresAt) > now) this.areas.set(state.area, state);
    }
    this.emitIfChanged();
  }

  snapshot() {
    this.cleanup();
    const areas = [...this.areas.values()].sort((a, b) => b.severity - a.severity || a.area.localeCompare(b.area, 'he'));
    const highest = areas[0] || null;
    return {
      status: highest?.kind || 'clear',
      severity: highest?.severity || 0,
      activeCount: areas.filter((item) => item.kind === 'alert').length,
      preAlertCount: areas.filter((item) => item.kind === 'pre_alert').length,
      endedCount: areas.filter((item) => item.kind === 'end').length,
      areas,
      updatedAt: new Date().toISOString(),
    };
  }

  emitIfChanged() {
    const snapshot = this.snapshotWithoutCleanup();
    const serialized = JSON.stringify(snapshot.areas);
    if (serialized === this.lastSnapshot) return;
    this.lastSnapshot = serialized;
    this.onChange?.(snapshot);
  }

  snapshotWithoutCleanup() {
    const areas = [...this.areas.values()].sort((a, b) => b.severity - a.severity || a.area.localeCompare(b.area, 'he'));
    const highest = areas[0] || null;
    return {
      status: highest?.kind || 'clear',
      severity: highest?.severity || 0,
      activeCount: areas.filter((item) => item.kind === 'alert').length,
      preAlertCount: areas.filter((item) => item.kind === 'pre_alert').length,
      endedCount: areas.filter((item) => item.kind === 'end').length,
      areas,
      updatedAt: new Date().toISOString(),
    };
  }
}
