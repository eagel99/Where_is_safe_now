export const REALTIME_TO_HISTORY = Object.freeze({
  1: 1,
  3: 7,
  4: 9,
  5: 11,
  6: 2,
  7: 12,
  13: 10,
});

export const PUSHY_TO_HISTORY = Object.freeze({
  0: 1,
  1: 12,
  2: 10,
  3: 7,
  4: 11,
  5: 2,
  6: 9,
  7: 14,
  8: 13,
  9: 8,
  11: 3,
});

export const TZEVAADOM_TO_HISTORY = Object.freeze({
  0: 1,
  1: 12,
  2: 10,
  3: 7,
  4: 11,
  5: 2,
  6: 9,
  7: 3,
  8: 4,
});

export const CATEGORY_METADATA = Object.freeze({
  1: { threat: 'missiles', label: 'ירי רקטות וטילים', severity: 3, isAlert: true },
  2: { threat: 'hostileAircraftIntrusion', label: 'חדירת כלי טיס עוין', severity: 3, isAlert: true },
  3: { threat: 'unconventionalMissile', label: 'ירי בלתי קונבנציונלי', severity: 3, isAlert: true },
  4: { threat: 'general', label: 'התרעה כללית', severity: 3, isAlert: true },
  7: { threat: 'earthquake', label: 'רעידת אדמה', severity: 3, isAlert: true },
  8: { threat: 'earthquakeUpdate', label: 'עדכון רעידת אדמה', severity: 3, isAlert: true },
  9: { threat: 'radiologicalEvent', label: 'אירוע רדיולוגי', severity: 3, isAlert: true },
  10: { threat: 'terroristInfiltration', label: 'חדירת מחבלים', severity: 3, isAlert: true },
  11: { threat: 'tsunami', label: 'חשש לצונאמי', severity: 3, isAlert: true },
  12: { threat: 'hazardousMaterials', label: 'חומרים מסוכנים', severity: 3, isAlert: true },
  13: { threat: 'update', label: 'האירוע הסתיים', severity: 1, isAlert: false },
  14: { threat: 'preAlert', label: 'התרעה מקדימה', severity: 2, isAlert: false },
});

export function categoryMetadata(category) {
  return CATEGORY_METADATA[Number(category)] || CATEGORY_METADATA[4];
}

export function kindFromHistoryCategory(category) {
  if (Number(category) === 14) return 'pre_alert';
  if (Number(category) === 13) return 'end';
  return 'alert';
}

export function classifyRealtimeCategory(category, title = '', description = '') {
  const value = Number(category);
  if (value === 10) {
    const text = `${title} ${description}`;
    return /בדקות|צפויות להתקבל התרעות|התרעה מקדימה/.test(text)
      ? { category: 14, kind: 'pre_alert' }
      : { category: 13, kind: 'end' };
  }
  return { category: REALTIME_TO_HISTORY[value] ?? 4, kind: 'alert' };
}
