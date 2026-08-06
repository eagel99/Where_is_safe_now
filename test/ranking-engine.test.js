import test from 'node:test';
import assert from 'node:assert';
import {
  computeRankings,
  tallyRows,
  dayRange,
  fmt,
  normalizeCity,
  safeParseJSON,
  RESPONSE_ROW_CAP,
} from '../src/rankings/ranking-engine.js';
import { makeBaseCityResolver, normalizeLabel } from '../src/rankings/area-catalog-source.js';

// A slice of the real district vocabulary, including the two dash shapes the
// API actually emits and an industrial zone that reads the other way round.
const CATALOG = [
  'אשדוד',
  'אשדוד - ג,ו,ז',
  'אשדוד -יא,יב,טו,יז,מרינה,סיטי',
  'אשקלון',
  'נחל עוז',
  'מטולה',
  'להבים',
  'אזור תעשייה עידן הנגב - להבים',
  'זמרת, שובה',
  "ע'ג'ר",
];
const baseCityOf = makeBaseCityResolver(CATALOG);
const baseCities = [...new Set(CATALOG.map(baseCityOf))];

test('resolves base cities from the catalog, not a hardcoded direction list', () => {
  assert.strictEqual(baseCityOf('אשדוד - ג,ו,ז'), 'אשדוד');
  // The API omits the space after the dash here; v1's hardcoded variant never matched.
  assert.strictEqual(baseCityOf('אשדוד -יא,יב,טו,יז,מרינה,סיטי'), 'אשדוד');
  // Industrial zones name the city on the right.
  assert.strictEqual(baseCityOf('אזור תעשייה עידן הנגב - להבים'), 'להבים');
  // Standalone labels are their own base city, commas and apostrophes included.
  assert.strictEqual(baseCityOf('נחל עוז'), 'נחל עוז');
  assert.strictEqual(baseCityOf('זמרת, שובה'), 'זמרת, שובה');
  assert.strictEqual(baseCityOf("ע'ג'ר"), "ע'ג'ר");
});

test('an unknown dashed label still falls back to its left side', () => {
  assert.strictEqual(baseCityOf('עיר חדשה - שכונה'), 'עיר חדשה');
});

test('normalizes whitespace, dash variants and BOM in area names', () => {
  assert.strictEqual(normalizeLabel(' תל  אביב – מזרח '), 'תל אביב - מזרח');
  assert.strictEqual(normalizeCity(null), 'Unknown');
  assert.strictEqual(normalizeCity('  '), 'Unknown');
});

test('tallies only missile and UAV rows, de-duplicating by rid', () => {
  const rows = [
    { rid: 1, data: 'אשקלון', category: 1, alertDate: '2026-08-05T10:00:00' },
    { rid: 1, data: 'אשקלון', category: 1, alertDate: '2026-08-05T10:00:00' }, // duplicate
    { rid: 2, data: 'אשקלון', category: 2, alertDate: '2026-08-05T11:00:00' },
    { rid: 3, data: 'מטולה', category: 14, alertDate: '2026-08-05T12:00:00' }, // early warning
    { rid: 4, data: 'מטולה', category: 13, alertDate: '2026-08-05T12:30:00' }, // end of event
    { rid: 5, data: 'נחל עוז', category: 10, alertDate: '2026-08-05T13:00:00' }, // infiltration
  ];
  const { counts } = tallyRows(rows, { cutoff: Date.parse('2026-08-01T00:00:00') });

  assert.strictEqual(counts.get('אשקלון'), 2);
  assert.strictEqual(counts.has('מטולה'), false, 'pre-alert and end rows are not ranked');
  assert.strictEqual(counts.has('נחל עוז'), false, 'infiltration is not a missile or UAV');
});

test('drops rows older than the window cutoff', () => {
  const rows = [
    { rid: 1, data: 'אשקלון', category: 1, alertDate: '2026-08-05T10:00:00' },
    { rid: 2, data: 'אשקלון', category: 1, alertDate: '2026-07-01T10:00:00' },
  ];
  const { counts } = tallyRows(rows, { cutoff: Date.parse('2026-08-01T00:00:00') });
  assert.strictEqual(counts.get('אשקלון'), 1);
});

test('carries seen ids across day-by-day calls so overlaps are not double counted', () => {
  const cutoff = Date.parse('2026-08-01T00:00:00');
  const first = tallyRows(
    [{ rid: 7, data: 'אשקלון', category: 1, alertDate: '2026-08-05T10:00:00' }],
    { cutoff },
  );
  const second = tallyRows(
    [{ rid: 7, data: 'אשקלון', category: 1, alertDate: '2026-08-05T10:00:00' }],
    { cutoff, seen: first.seen, counts: first.counts },
  );
  assert.strictEqual(second.counts.get('אשקלון'), 1);
});

test('merges sub-region counts by max so multi-zone cities are not inflated', () => {
  const counts = new Map([
    ['אשדוד - ג,ו,ז', 12],
    ['אשדוד -יא,יב,טו,יז,מרינה,סיטי', 9],
    ['אשקלון', 20],
    ['אזור תעשייה עידן הנגב - להבים', 3],
  ]);
  const rankings = computeRankings(counts, {
    baseCityOf,
    baseCities,
    fromDate: '01.08.2026',
    toDate: '08.08.2026',
    updatedAt: '2026-08-08T00:00:00.000Z',
    areasKnown: CATALOG.length,
  });

  const ashdod = rankings.allCities.find((city) => city.city === 'אשדוד');
  assert.strictEqual(ashdod.count, 12, 'sub-regions merge by max, not sum');
  assert.strictEqual(rankings.allCities.find((city) => city.city === 'להבים').count, 3);

  assert.deepStrictEqual(rankings.most.map((city) => city.city), ['אשקלון', 'אשדוד', 'להבים']);
  // The window total still counts every raw sub-region alert.
  assert.strictEqual(rankings.totalAlerts, 44);
  assert.strictEqual(rankings.totalCities, 3, 'only cities that were actually hit');
  assert.strictEqual(rankings.areasKnown, CATALOG.length);
});

test('allCities covers the whole catalog so quiet places are still selectable', () => {
  const rankings = computeRankings(new Map([['אשקלון', 4]]), {
    baseCityOf,
    baseCities,
    fromDate: 'x',
    toDate: 'y',
    updatedAt: 'z',
  });

  assert.strictEqual(rankings.allCities.length, baseCities.length);
  const quiet = rankings.allCities.find((city) => city.city === 'מטולה');
  assert.ok(quiet, 'a city with no alerts must still be listed');
  assert.strictEqual(quiet.count, 0);
  // ...but it must not show up as a ranked result.
  assert.strictEqual(rankings.most.length, 1);
  assert.deepStrictEqual(rankings.least.map((city) => city.city), ['אשקלון']);
});

test('least-hit list is ascending and only counts cities that were hit', () => {
  const rankings = computeRankings(
    new Map([['אשקלון', 5], ['אשדוד', 4], ['נחל עוז', 3], ['מטולה', 2], ['להבים', 1]]),
    { baseCityOf, baseCities, fromDate: 'x', toDate: 'y', updatedAt: 'z' },
  );
  assert.deepStrictEqual(rankings.least.map((city) => city.city), ['להבים', 'מטולה', 'נחל עוז']);
  assert.deepStrictEqual(rankings.most.map((city) => city.city), ['אשקלון', 'אשדוד', 'נחל עוז']);
});

test('splits a window into whole days, newest first', () => {
  const days = dayRange(new Date(2026, 7, 1), new Date(2026, 7, 4));
  assert.deepStrictEqual(days.map(fmt), ['04.08.2026', '03.08.2026', '02.08.2026', '01.08.2026']);
});

test('formats dates the way the Oref history endpoint expects', () => {
  assert.strictEqual(fmt(new Date(2026, 0, 5)), '05.01.2026');
  assert.strictEqual(fmt(new Date(2026, 11, 31)), '31.12.2026');
});

test('safeParseJSON guards the upstream response', () => {
  assert.deepStrictEqual(safeParseJSON('{"some":"object"}'), []);
  assert.deepStrictEqual(safeParseJSON(''), []);
  assert.strictEqual(safeParseJSON('[{"__proto__":{"x":1}}]').length, 0);
  assert.strictEqual(safeParseJSON('[{"rid":1,"data":"חיפה"}]').length, 1);
});

test('the row cap is the documented upstream limit', () => {
  assert.strictEqual(RESPONSE_ROW_CAP, 3000);
});
