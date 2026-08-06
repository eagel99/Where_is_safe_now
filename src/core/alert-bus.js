import { EventEmitter } from 'node:events';
import { candidateMatchesEvent, createEvent, mergeCandidate } from './correlation.js';
import { passesAreaFilter } from './normalize.js';
import { AreaStateStore } from './state-store.js';

export class AlertBus extends EventEmitter {
  constructor({ config, logger, eventStore, areaCatalog }) {
    super();
    this.config = config;
    this.logger = logger;
    this.eventStore = eventStore;
    this.areaCatalog = areaCatalog;
    this.recent = [];
    this.candidateIds = new Map();
    this.sources = new Map();
    this.deliveries = [];
    this.metrics = {
      candidates: 0,
      newEvents: 0,
      mergedCandidates: 0,
      filtered: 0,
      duplicateCandidates: 0,
      deliveries: 0,
    };
    this.stateStore = new AreaStateStore(config, (state) => {
      this.emit('state', state);
      this.saveSnapshot();
    });
  }

  restore(snapshot = {}) {
    this.recent = Array.isArray(snapshot.recent) ? snapshot.recent.slice(0, this.config.recentAlertsLimit) : [];
    this.deliveries = Array.isArray(snapshot.deliveries) ? snapshot.deliveries.slice(-200) : [];
    this.stateStore.restore(snapshot.states || []);
  }

  setSourceStatus(name, patch) {
    const current = this.sources.get(name) || { name, state: 'starting' };
    const next = { ...current, ...patch, name, updatedAt: new Date().toISOString() };
    this.sources.set(name, next);
    this.emit('source-status', next);
  }

  publishCandidate(candidate) {
    this.metrics.candidates += 1;
    if (!candidate.areas.length && !candidate.areaIds.length) {
      this.metrics.filtered += 1;
      return null;
    }
    if (!passesAreaFilter(candidate, this.config.areaFilter)) {
      this.metrics.filtered += 1;
      return null;
    }

    this.cleanup();
    if (this.candidateIds.has(candidate.candidateId)) {
      this.metrics.duplicateCandidates += 1;
      return this.candidateIds.get(candidate.candidateId);
    }

    const existing = this.recent.find((event) => candidateMatchesEvent(candidate, event, this.config.correlationWindowMs));
    if (existing) {
      this.candidateIds.set(candidate.candidateId, existing);
      const changed = mergeCandidate(existing, candidate);
      existing.areaDetails = this.areaCatalog.detailsFor(existing.areas);
      this.metrics.mergedCandidates += 1;
      this.stateStore.apply(existing);
      if (changed) {
        this.emit('alert-update', existing);
        void this.eventStore.appendEvent(existing, 'alert-update').catch((error) => this.logger.error({ err: error.message }, 'Event persistence failed'));
        this.saveSnapshot();
      }
      return existing;
    }

    const event = createEvent(candidate);
    event.primarySource = candidate.source;
    event.areaDetails = this.areaCatalog.detailsFor(event.areas);
    this.candidateIds.set(candidate.candidateId, event);
    this.recent.unshift(event);
    if (this.recent.length > this.config.recentAlertsLimit) this.recent.length = this.config.recentAlertsLimit;
    this.metrics.newEvents += 1;
    this.stateStore.apply(event);
    this.emit('alert', event);
    void this.eventStore.appendEvent(event, 'alert').catch((error) => this.logger.error({ err: error.message }, 'Event persistence failed'));
    this.logger.warn({ eventId: event.eventId, kind: event.kind, areas: event.areas, source: event.primarySource }, 'New emergency event');
    this.saveSnapshot();
    return event;
  }

  addDelivery(delivery) {
    this.deliveries.push(delivery);
    if (this.deliveries.length > 200) this.deliveries.splice(0, this.deliveries.length - 200);
    this.metrics.deliveries += 1;
    this.emit('action-delivery', delivery);
    void this.eventStore.appendDelivery(delivery).catch((error) => this.logger.error({ err: error.message }, 'Delivery persistence failed'));
    this.saveSnapshot();
  }

  cleanup() {
    const candidateCutoff = Date.now() - Math.max(this.config.correlationWindowMs * 4, 180_000);
    for (const [id, event] of this.candidateIds.entries()) {
      if (Date.parse(event.lastSeenAt) < candidateCutoff) this.candidateIds.delete(id);
    }
    this.stateStore.cleanup();
  }

  currentState() {
    return this.stateStore.snapshot();
  }

  sourceList() {
    return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  sourceHealthy(source, now = Date.now()) {
    if (source.state === 'connected') return true;
    if (source.state !== 'polling') return false;
    if (!source.lastSuccessAt) return false;
    return now - Date.parse(source.lastSuccessAt) < Math.max((source.intervalMs || 1000) * 5, 15_000);
  }

  health() {
    const now = Date.now();
    const sources = this.sourceList();
    const official = sources.filter((source) => source.role?.startsWith('official-'));
    const fast = sources.filter((source) => source.role?.startsWith('fast-'));
    const officialHealthy = official.some((source) => this.sourceHealthy(source, now));
    const officialRealtimeHealthy = official.some((source) => source.name === 'oref-realtime' && this.sourceHealthy(source, now));
    const fastHealthy = fast.some((source) => this.sourceHealthy(source, now));
    return {
      ok: officialHealthy,
      mode: officialRealtimeHealthy && fastHealthy
        ? 'fast-and-verified'
        : officialRealtimeHealthy
          ? 'official-only'
          : officialHealthy
            ? 'recovery-only'
            : 'degraded',
      now: new Date(now).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      state: this.currentState(),
      sources,
      metrics: { ...this.metrics },
    };
  }

  saveSnapshot() {
    this.eventStore.saveSnapshot({
      savedAt: new Date().toISOString(),
      recent: this.recent,
      states: this.stateStore.snapshotWithoutCleanup().areas,
      deliveries: this.deliveries,
    });
  }
}
