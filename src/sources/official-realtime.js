import { classifyRealtimeCategory } from '../core/categories.js';
import { makeCandidate } from '../core/normalize.js';
import { PollingSource } from './polling-source.js';
import { fetchOrefJson, OREF_REALTIME_URL } from './http-client.js';

export class OfficialRealtimeSource extends PollingSource {
  constructor({ bus, config, logger }) {
    super({ name: 'oref-realtime', intervalMs: config.orefPollMs, bus, logger, role: 'official-fast-verification' });
    this.config = config;
  }

  async poll() {
    const json = await fetchOrefJson(OREF_REALTIME_URL, this.config);
    if (!json || !Array.isArray(json.data) || !json.data.length) return 0;

    const classified = classifyRealtimeCategory(json.cat, json.title, json.desc);
    this.bus.publishCandidate(makeCandidate({
      source: this.name,
      rawId: json.id,
      kind: classified.kind,
      category: classified.category,
      title: json.title,
      instructions: json.desc,
      areas: json.data,
      occurredAt: json.alertDate || json.date || undefined,
      raw: json,
    }, this.config));
    return 1;
  }
}
