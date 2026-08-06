import { kindFromHistoryCategory } from '../core/categories.js';
import { makeCandidate, parseOccurredAt } from '../core/normalize.js';
import { PollingSource } from './polling-source.js';
import { fetchOrefJson, OREF_EXTENDED_HISTORY_URL, rowsFromResponse } from './http-client.js';

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${day}.${month}.${year}`;
}

export class OfficialExtendedHistorySource extends PollingSource {
  constructor({ bus, config, logger }) {
    super({
      name: 'oref-extended-history',
      intervalMs: config.orefExtendedHistoryMs,
      bus,
      logger,
      role: 'official-deep-recovery',
    });
    this.config = config;
  }

  async poll() {
    const now = new Date();
    const json = await fetchOrefJson(OREF_EXTENDED_HISTORY_URL, this.config, {
      params: { lang: 'he', fromDate: localDate(now), toDate: localDate(now), mode: 0 },
      headers: { Referer: 'https://www.oref.org.il/heb/alerts-history' },
    });
    const rows = rowsFromResponse(json);
    const cutoff = Date.now() - this.config.historyCatchupMs;
    let accepted = 0;

    for (const row of rows) {
      const category = Number(row.category ?? row.cat ?? row.alertCategory ?? 4);
      if (!this.config.includeDrills && category >= 15) continue;
      const occurredAt = parseOccurredAt(row.alertDate ?? row.date ?? row.time);
      if (Date.parse(occurredAt) < cutoff) continue;
      const rawAreas = row.data ?? row.cities ?? row.city ?? row.name;
      const areas = Array.isArray(rawAreas)
        ? rawAreas
        : String(rawAreas || '').split(',').map((value) => value.trim()).filter(Boolean);
      const candidate = makeCandidate({
        source: this.name,
        rawId: row.id || `${occurredAt}:${category}:${areas.join('|')}`,
        kind: kindFromHistoryCategory(category),
        category,
        title: row.title,
        instructions: row.desc ?? row.instructions,
        areas,
        occurredAt,
        raw: row,
      }, this.config);
      if (this.bus.publishCandidate(candidate)) accepted += 1;
    }
    return accepted;
  }
}
