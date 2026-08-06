import axios from 'axios';

export const OREF_REALTIME_URL = 'https://www.oref.org.il/warningMessages/alert/Alerts.json';
export const OREF_HISTORY_URL = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
export const OREF_EXTENDED_HISTORY_URL = 'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx';

export const orefHeaders = Object.freeze({
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache, no-store, max-age=0',
  Referer: 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (compatible; OrefCommandCenter/2.0)',
});

function decodeResponse(data) {
  let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
  let encoding = 'utf8';

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    buffer = buffer.subarray(2);
    encoding = 'utf16le';
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    buffer = buffer.subarray(3);
  }

  return buffer
    .toString(encoding)
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .replace(/\u0A7B/g, '')
    .trim();
}

export async function fetchOrefJson(url, config, options = {}) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await axios.get(`${url}${separator}_=${Date.now()}`, {
    responseType: 'arraybuffer',
    timeout: config.requestTimeoutMs,
    maxRedirects: 2,
    headers: { ...orefHeaders, ...(options.headers || {}) },
    params: options.params,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const text = decodeResponse(response.data);
  if (!text) return null;
  if (/\/errorpage_adom\//i.test(text) || /^\s*</.test(text)) {
    throw new Error('Oref returned an HTML error page');
  }
  return JSON.parse(text);
}

export function rowsFromResponse(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['data', 'alerts', 'results', 'value']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}
