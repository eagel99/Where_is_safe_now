import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import mqtt from 'mqtt';
import { PUSHY_TO_HISTORY, kindFromHistoryCategory } from '../core/categories.js';
import { makeCandidate } from '../core/normalize.js';

const PUSHY_API = 'https://pushy.ioref.app';
const APP_ID = '66c20ac875260a035a3af7b2';
const ANDROID_SUFFIX = '-Google-Android-SDK-built-for-x86_64';

function registrationBody(androidId) {
  return { androidId, app: null, appId: APP_ID, platform: 'android', sdk: 10117 };
}

async function post(config, uri, body) {
  const response = await axios.post(`${PUSHY_API}/${uri}`, body, {
    timeout: config.requestTimeoutMs,
    maxRedirects: 0,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'OrefCommandCenter/2.0' },
  });
  return response.data;
}

export class PushyMobileSource {
  constructor({ bus, config, logger, areaCatalog }) {
    this.name = 'oref-mobile-pushy';
    this.bus = bus;
    this.config = config;
    this.logger = logger;
    this.areaCatalog = areaCatalog;
    this.client = null;
    this.credentials = null;
    this.stopped = true;
    this.credentialsFile = path.join(config.dataDir, 'pushy-credentials.json');
  }

  async start() {
    this.stopped = false;
    this.bus.setSourceStatus(this.name, {
      state: 'starting',
      role: 'fast-unofficial-mobile-push',
      experimental: true,
    });
    try {
      await fs.mkdir(path.dirname(this.credentialsFile), { recursive: true });
      this.credentials = await this.loadOrRegister();
      const topics = this.resolveTopics();
      await this.subscribeTopics(topics);
      this.connectMqtt(topics.length);
    } catch (error) {
      this.bus.setSourceStatus(this.name, { state: 'error', lastError: error.message });
      this.logger.error({ source: this.name, err: error.message }, 'Mobile push source failed to start');
    }
  }

  stop() {
    this.stopped = true;
    this.client?.end(true);
  }

  resolveTopics() {
    const explicit = this.config.pushySegmentIds;
    if (explicit.length) return [...new Set(explicit.map(String))];
    if (this.config.areaFilter.length) {
      const filtered = this.areaCatalog.segmentIdsForAreas(this.config.areaFilter);
      if (filtered.length) return [...new Set(filtered)];
    }
    if (this.config.pushyAllSegments) return this.areaCatalog.allSegmentIds();
    return [];
  }

  async loadOrRegister() {
    try {
      const stored = JSON.parse(await fs.readFile(this.credentialsFile, 'utf8'));
      if (stored?.token && stored?.auth) return stored;
    } catch {
      // Register below.
    }

    const androidId = `${crypto.randomBytes(8).toString('hex')}${ANDROID_SUFFIX}`;
    const credentials = await post(this.config, 'register', registrationBody(androidId));
    if (!credentials?.token || !credentials?.auth) throw new Error('Invalid mobile push registration response');
    const stored = { ...credentials, androidId, createdAt: new Date().toISOString() };
    await fs.writeFile(this.credentialsFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
    return stored;
  }

  async subscribeTopics(topics) {
    if (!topics.length) throw new Error('No mobile push segments configured or discovered');
    for (let index = 0; index < topics.length; index += 250) {
      const chunk = topics.slice(index, index + 250);
      const response = await post(this.config, 'devices/subscribe', {
        token: this.credentials.token,
        auth: this.credentials.auth,
        topics: chunk,
      });
      if (response?.success === false) throw new Error(`Mobile push subscription rejected: ${JSON.stringify(response)}`);
    }
  }

  connectMqtt(topicCount) {
    const host = `mqtt-${Math.floor(Date.now() / 1000)}.ioref.io`;
    this.client = mqtt.connect(`mqtts://${host}:443`, {
      clientId: this.credentials.token,
      username: this.credentials.token,
      password: this.credentials.auth,
      clean: false,
      keepalive: 300,
      reconnectPeriod: 3000,
      connectTimeout: this.config.requestTimeoutMs,
      rejectUnauthorized: true,
    });

    this.client.on('connect', () => {
      this.bus.setSourceStatus(this.name, {
        state: 'connected',
        role: 'fast-unofficial-mobile-push',
        connectedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        topicCount,
        experimental: true,
        lastError: null,
      });
      this.client.subscribe(this.credentials.token, { qos: 1 }, (error) => {
        if (error) this.bus.setSourceStatus(this.name, { state: 'error', lastError: error.message });
      });
    });
    this.client.on('reconnect', () => this.bus.setSourceStatus(this.name, { state: 'reconnecting' }));
    this.client.on('offline', () => this.bus.setSourceStatus(this.name, { state: 'offline' }));
    this.client.on('error', (error) => this.bus.setSourceStatus(this.name, { state: 'error', lastError: error.message }));
    this.client.on('message', (_topic, payload) => this.onMessage(payload));
  }

  onMessage(payload) {
    try {
      const message = JSON.parse(payload.toString('utf8'));
      if (message.test && !this.config.includeDrills) return;
      const category = PUSHY_TO_HISTORY[Number(message.threatId)];
      if (!category) return;
      const ids = String(message.citiesIds || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const areas = ids.map((id) => this.areaCatalog.segmentToArea.get(id)).filter(Boolean);
      this.bus.publishCandidate(makeCandidate({
        source: this.name,
        rawId: `${message.time || ''}:${message.threatId || ''}:${ids.join('-')}`,
        kind: kindFromHistoryCategory(category),
        category,
        title: message.title || message.body,
        instructions: message.body,
        areas,
        areaIds: ids,
        occurredAt: message.time,
        raw: message,
      }, this.config));
      this.bus.setSourceStatus(this.name, { lastSuccessAt: new Date().toISOString(), lastError: null });
    } catch (error) {
      this.logger.warn({ source: this.name, err: error.message }, 'Ignored invalid mobile push message');
    }
  }
}
