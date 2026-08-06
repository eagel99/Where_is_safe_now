import { kindFromHistoryCategory } from '../core/categories.js';
import { makeCandidate, parseOccurredAt } from '../core/normalize.js';
import { PollingSource } from './polling-source.js';
import { fetchOrefJson, OREF_HISTORY_URL, rowsFromResponse } from './http-client.js';

export class OfficialHistorySource extends PollingSource {
  constructor({ bus, config, logger }) {
    super({ name: 'oref-history', intervalMs: config.orefHistoryMs, bus, logger, role: 'official-recovery' });
    this.config = config;
  }

  async poll() {
    const rows = rowsFromResponse(await fetchOrefJson(OREF_HISTORY_URL, this.config));
    const cutoff = Date.now() - this.config.historyCatchupMs;
    let accepted = 0;

    for (const row of rows) {
      const category = Number(row.category ?? row.cat);
      if (!this.config.includeDrills && category >= 15) continue;
      const occurredAt = parseOccurredAt(row.alertDate ?? row.date ?? row.time);
      if (Date.parse(occurredAt) < cutoff) continue;
      const area = row.data ?? row.city ?? row.name;
      const candidate = makeCandidate({
        source: this.name,
        rawId: row.id || `${occurredAt}:${category}:${area || ''}`,
        kind: kindFromHistoryCategory(category),
        category,
        title: row.title,
        instructions: row.desc ?? row.instructions,
        areas: Array.isArray(area) ? area : [area],
        occurredAt,
        raw: row,
      }, this.config);
      if (this.bus.publishCandidate(candidate)) accepted += 1;
    }
    return accepted;
  }
}
