import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import axios from 'axios';
import mqtt from 'mqtt';
import { eventMatchesRule, interpolateTemplate, normalizeRules } from './action-matcher.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !FORBIDDEN_HEADERS.has(key.toLowerCase())));
}

function deliveryId(rule, action, event) {
  return crypto.createHash('sha256')
    .update(`${rule.id}:${action.id || action.type}:${event.eventId}`)
    .digest('hex')
    .slice(0, 24);
}

export class ActionEngine {
  constructor({ config, logger, onDelivery }) {
    this.config = config;
    this.logger = logger;
    this.onDelivery = onDelivery;
    this.rules = [];
    this.deliveries = [];
    this.executedKeys = new Set();
    this.ruleRuns = new Map();
    this.mqttClient = null;
  }

  async init(snapshotDeliveries = []) {
    this.restore(snapshotDeliveries);
    await this.reload();
  }

  restore(deliveries) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const delivery of deliveries || []) {
      if (delivery?.deliveryId && Date.parse(delivery.completedAt || delivery.startedAt || 0) > cutoff) {
        this.executedKeys.add(delivery.deliveryId);
        this.deliveries.push(delivery);
      }
    }
    this.deliveries = this.deliveries.slice(-200);
  }

  async reload() {
    try {
      const document = JSON.parse(await fs.readFile(this.config.actionsFile, 'utf8'));
      this.rules = normalizeRules(document);
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.error({ err: error.message }, 'Could not load action rules');
      this.rules = [];
    }
    return this.publicStatus();
  }

  publicStatus() {
    return {
      enabled: this.config.actionsEnabled,
      irreversibleEnabled: this.config.allowIrreversibleActions,
      rules: this.rules.map((rule) => ({
        id: rule.id,
        name: rule.name || rule.id,
        enabled: rule.enabled === true,
        actions: (rule.actions || []).map((action) => ({
          id: action.id || action.type,
          type: action.type,
          irreversible: action.irreversible === true,
        })),
      })),
      recentDeliveries: this.deliveries.slice(-50).reverse(),
    };
  }

  async handle(event, { isUpdate = false } = {}) {
    if (!this.config.actionsEnabled) return;
    for (const rule of this.rules) {
      if (rule.enabled !== true || !eventMatchesRule(event, rule)) continue;
      if (isUpdate && rule.triggerOnUpdate !== true) continue;
      if (!this.withinLimits(rule)) continue;
      for (const action of rule.actions || []) {
        await this.execute(rule, action, event);
      }
    }
  }

  withinLimits(rule) {
    const now = Date.now();
    const runs = (this.ruleRuns.get(rule.id) || []).filter((at) => now - at < 60 * 60 * 1000);
    this.ruleRuns.set(rule.id, runs);
    const max = Number(rule.maxExecutionsPerHour || 20);
    if (runs.length >= max) return false;
    const cooldownMs = Number(rule.cooldownSeconds || 0) * 1000;
    return !cooldownMs || !runs.length || now - runs.at(-1) >= cooldownMs;
  }

  irreversibleAllowed(rule, action) {
    if (action.irreversible !== true) return true;
    return this.config.allowIrreversibleActions
      && rule.allowIrreversible === true
      && action.confirmIrreversible === true;
  }

  async execute(rule, action, event) {
    const id = deliveryId(rule, action, event);
    if (this.executedKeys.has(id)) return;
    this.executedKeys.add(id);
    this.ruleRuns.set(rule.id, [...(this.ruleRuns.get(rule.id) || []), Date.now()]);

    const delivery = {
      deliveryId: id,
      ruleId: rule.id,
      actionId: action.id || action.type,
      actionType: action.type,
      eventId: event.eventId,
      irreversible: action.irreversible === true,
      status: 'running',
      attempts: 0,
      startedAt: new Date().toISOString(),
    };

    if (!this.irreversibleAllowed(rule, action)) {
      return this.complete(delivery, 'blocked', 'Irreversible action requires all three explicit safety switches');
    }

    try {
      if (action.type === 'webhook') await this.executeWithRetry(delivery, () => this.sendWebhook(rule, action, event, id));
      else if (action.type === 'mqtt') await this.executeWithRetry(delivery, () => this.sendMqtt(rule, action, event));
      else if (action.type === 'log') this.logger.warn({ rule: rule.id, event }, action.message || 'Alert action');
      else throw new Error(`Unsupported action type: ${action.type}`);
      this.complete(delivery, 'delivered');
    } catch (error) {
      this.complete(delivery, 'failed', error.message);
    }
  }

  async executeWithRetry(delivery, operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.actionMaxRetries; attempt += 1) {
      delivery.attempts = attempt + 1;
      try {
        await operation();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.config.actionMaxRetries) await sleep(Math.min(8000, 500 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  validateWebhook(urlValue) {
    const url = new URL(urlValue);
    const isLocal = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
      throw new Error('Webhooks require HTTPS, except localhost development URLs');
    }
    const allowed = this.config.actionAllowedHosts;
    if (!isLocal && (!allowed.length || !allowed.includes(url.hostname.toLowerCase()))) {
      throw new Error(`Webhook host is not in ACTION_ALLOWED_HOSTS: ${url.hostname}`);
    }
    return url;
  }

  async sendWebhook(rule, action, event, id) {
    const url = this.validateWebhook(interpolateTemplate(action.url, event));
    const payload = action.payload == null
      ? { event, automation: { ruleId: rule.id, actionId: action.id || action.type } }
      : interpolateTemplate(action.payload, event);
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': id,
      'X-Oref-Event-Id': event.eventId,
      ...safeHeaders(interpolateTemplate(action.headers || {}, event)),
    };
    if (this.config.actionHmacSecret) {
      headers['X-Oref-Signature'] = `sha256=${crypto.createHmac('sha256', this.config.actionHmacSecret).update(body).digest('hex')}`;
    }
    await axios.request({
      method: 'POST',
      url: url.toString(),
      data: body,
      headers,
      timeout: this.config.actionRequestTimeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  mqttConnection() {
    if (!this.config.actionMqttUrl) throw new Error('ACTION_MQTT_URL is not configured');
    if (this.mqttClient) return this.mqttClient;
    this.mqttClient = mqtt.connect(this.config.actionMqttUrl, {
      username: this.config.actionMqttUsername || undefined,
      password: this.config.actionMqttPassword || undefined,
      reconnectPeriod: 3000,
      connectTimeout: this.config.actionRequestTimeoutMs,
    });
    return this.mqttClient;
  }

  async sendMqtt(rule, action, event) {
    const topic = interpolateTemplate(action.topic, event);
    if (!topic || topic.includes('#') || topic.includes('+')) throw new Error('MQTT action requires a concrete topic');
    const payload = action.payload == null
      ? { event, automation: { ruleId: rule.id, actionId: action.id || action.type } }
      : interpolateTemplate(action.payload, event);
    const client = this.mqttConnection();
    await new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(payload), {
        qos: Number(action.qos) === 1 ? 1 : 0,
        retain: action.retain === true,
      }, (error) => error ? reject(error) : resolve());
    });
  }

  complete(delivery, status, error = null) {
    delivery.status = status;
    delivery.error = error;
    delivery.completedAt = new Date().toISOString();
    this.deliveries.push({ ...delivery });
    if (this.deliveries.length > 200) this.deliveries.splice(0, this.deliveries.length - 200);
    this.onDelivery?.({ ...delivery });
    if (status === 'failed') this.logger.error({ delivery }, 'Alert action failed');
    if (status === 'blocked') this.logger.warn({ delivery }, 'Alert action blocked');
    return delivery;
  }

  stop() {
    this.mqttClient?.end(true);
  }
}
