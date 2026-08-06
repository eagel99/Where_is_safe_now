import fs from 'node:fs';
import WebSocket from 'ws';
import { TZEVAADOM_TO_HISTORY } from '../core/categories.js';
import { makeCandidate } from '../core/normalize.js';

const WS_URL = 'wss://ws.tzevaadom.co.il/socket?platform=WEB';
const ORIGIN = 'https://www.tzevaadom.co.il';
const THREAT_TITLES = Object.freeze({
  0: 'ירי רקטות וטילים',
  1: 'אירוע חומרים מסוכנים',
  2: 'חדירת מחבלים',
  3: 'רעידת אדמה',
  4: 'חשש לצונאמי',
  5: 'חדירת כלי טיס עוין',
  6: 'חשש לאירוע רדיולוגי',
  7: 'חשש לאירוע כימי',
  8: 'התרעות פיקוד העורף',
});

function readIdMap(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function decodeMessage(payload) {
  const outer = JSON.parse(payload.toString('utf8'));
  if (typeof outer === 'string') return JSON.parse(outer);
  if (typeof outer?.data === 'string' && /^[{[]/.test(outer.data.trim())) {
    return { ...outer, data: JSON.parse(outer.data) };
  }
  return outer;
}

function messageTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number < 10_000_000_000 ? number * 1000 : number;
}

export class TzevaAdomWsSource {
  constructor({ bus, config, logger }) {
    this.name = 'tzevaadom-ws';
    this.bus = bus;
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.idMap = readIdMap(config.tzevaAdomIdMapFile);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
  }

  connect() {
    if (this.stopped) return;
    this.bus.setSourceStatus(this.name, {
      state: 'connecting',
      role: 'fast-third-party-push',
      experimental: true,
    });

    this.ws = new WebSocket(WS_URL, {
      origin: ORIGIN,
      handshakeTimeout: this.config.requestTimeoutMs,
      perMessageDeflate: false,
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.bus.setSourceStatus(this.name, {
        state: 'connected',
        role: 'fast-third-party-push',
        connectedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        experimental: true,
        lastError: null,
      });
      this.logger.info('Tzeva Adom WebSocket connected');
    });

    this.ws.on('message', (payload) => {
      try {
        this.onMessage(decodeMessage(payload));
        this.bus.setSourceStatus(this.name, { lastSuccessAt: new Date().toISOString(), lastError: null });
      } catch (error) {
        this.logger.warn({ source: this.name, err: error.message }, 'Ignored invalid WebSocket message');
      }
    });

    this.ws.on('ping', (data) => this.ws?.pong(data));
    this.ws.on('error', (error) => {
      this.bus.setSourceStatus(this.name, { state: 'error', lastError: error.message });
    });
    this.ws.on('close', (code, reason) => {
      this.bus.setSourceStatus(this.name, {
        state: 'disconnected',
        disconnectedAt: new Date().toISOString(),
        closeCode: code,
        closeReason: reason.toString(),
      });
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const exponential = Math.min(30_000, 1000 * (2 ** Math.min(this.reconnectAttempts, 5)));
    const delay = exponential + Math.floor(Math.random() * 1000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  onMessage(message) {
    const type = String(message?.type || message?.event || '').toUpperCase();
    const data = message?.data || message?.payload || {};

    if (type === 'ALERT') {
      if (data.isDrill && !this.config.includeDrills) return;
      const category = TZEVAADOM_TO_HISTORY[Number(data.threat)];
      if (!category) return;
      this.bus.publishCandidate(makeCandidate({
        source: this.name,
        rawId: `ALERT_${data.notificationId || data.id || data.time || ''}`,
        kind: 'alert',
        category,
        title: data.title || THREAT_TITLES[Number(data.threat)],
        instructions: data.instructions || data.description,
        areas: data.cities || data.areas || [],
        areaIds: data.citiesIds || data.areaIds || [],
        occurredAt: messageTime(data.time || data.timestamp),
        raw: message,
      }, this.config));
      return;
    }

    if (type !== 'SYSTEM_MESSAGE') return;
    const instruction = Number(data.instructionType ?? data.instruction);
    if (![0, 1].includes(instruction)) return;
    const ids = (Array.isArray(data.citiesIds) ? data.citiesIds : String(data.citiesIds || '').split(','))
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean);
    const mappedAreas = ids.map((id) => this.idMap[id]).filter(Boolean);
    const directAreas = Array.isArray(data.cities) ? data.cities : [];
    const kind = instruction === 0 ? 'pre_alert' : 'end';

    this.bus.publishCandidate(makeCandidate({
      source: this.name,
      rawId: `SYSTEM_${data.notificationId || data.id || data.time || ids.join('-')}`,
      kind,
      category: kind === 'pre_alert' ? 14 : 13,
      title: data.title || (kind === 'pre_alert'
        ? 'בדקות הקרובות צפויות להתקבל התרעות באזורך'
        : 'האירוע הסתיים'),
      instructions: data.instructions || data.description,
      areas: [...directAreas, ...mappedAreas],
      areaIds: ids,
      occurredAt: messageTime(data.time || data.timestamp),
      raw: message,
    }, this.config));
  }
}
