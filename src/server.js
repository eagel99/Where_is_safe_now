import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import helmet from 'helmet';
import { makeCandidate } from './core/normalize.js';
import { clientIp, RateLimiter, SseRegistry } from './http/hardening.js';

const require = createRequire(import.meta.url);

function authorized(req, config) {
  if (!config.adminToken) return false;
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(config.adminToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function compatibilityCurrent(bus) {
  const active = bus.currentState().areas.filter((state) => state.kind !== 'end');
  if (!active.length) return null;
  const latest = bus.recent.find((event) => event.areas.some((area) => active.some((state) => state.area === area)));
  if (!latest) return null;
  return {
    id: latest.eventId,
    cat: String(latest.category),
    title: latest.title,
    data: latest.areas,
    desc: latest.instructions,
    source: latest.primarySource,
    occurredAt: latest.occurredAt,
  };
}

export function createApp({ bus, actionEngine, rankingEngine = null, config, logger }) {
  const app = express();
  app.disable('x-powered-by');

  const rateLimiter = new RateLimiter({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax });
  const sseRegistry = new SseRegistry(config.maxSseListeners);

  // Rate limiting runs ahead of everything, static assets included, so a flood
  // cannot be laundered through the file server.
  app.use((req, res, next) => {
    if (rateLimiter.isLimited(clientIp(req, config.trustProxy))) {
      res.status(429).type('text/plain').send('Too many requests');
      return;
    }
    if (config.allowedOrigin) res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        // Browsers that support frame-ancestors ignore X-Frame-Options, so
        // this has to say 'none' too or the DENY below is decorative.
        frameAncestors: ["'none'"],
      },
    },
    // helmet defaults to SAMEORIGIN; this app is never meant to be framed.
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '128kb' }));

  // Every SSE client registers one listener per event name on the bus and on
  // the ranking engine. The cap is the real bound, so raise the emitter limit
  // to match instead of emitting a spurious leak warning at 10 viewers.
  const listenerHeadroom = config.maxSseListeners + 10;
  bus.setMaxListeners(listenerHeadroom);
  rankingEngine?.setMaxListeners?.(listenerHeadroom);

  let leafletDir = null;
  try {
    leafletDir = path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist');
  } catch {
    logger.warn('Leaflet package not installed yet, map assets will be unavailable until npm install');
  }
  if (leafletDir) app.use('/vendor/leaflet', express.static(leafletDir, { immutable: true, maxAge: '7d' }));
  app.use(express.static(config.publicDir, { extensions: ['html'], maxAge: '5m' }));

  const healthHandler = (_req, res) => {
    const health = bus.health();
    res.status(health.ok ? 200 : 503).json(health);
  };
  const stateHandler = (_req, res) => res.json(bus.currentState());
  const sourcesHandler = (_req, res) => res.json(bus.sourceList());
  const alertsHandler = (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const kind = req.query.kind ? String(req.query.kind) : null;
    const source = req.query.source ? String(req.query.source) : null;
    const events = bus.recent.filter((event) => (!kind || event.kind === kind) && (!source || event.sources.includes(source)));
    res.json(events.slice(0, limit));
  };

  app.get('/api/v1/health', healthHandler);
  app.get('/api/v1/state', stateHandler);
  app.get('/api/v1/sources', sourcesHandler);
  app.get('/api/v1/alerts', alertsHandler);
  app.get('/api/v1/actions', (_req, res) => res.json(actionEngine.publicStatus()));
  app.get('/api/v1/geojson', async (_req, res) => {
    try {
      const document = JSON.parse(await fs.readFile(config.geoJsonFile, 'utf8'));
      return res.json(document);
    } catch (error) {
      if (error.code === 'ENOENT') return res.json({ type: 'FeatureCollection', features: [] });
      throw error;
    }
  });

  app.post('/api/v1/actions/reload', async (req, res) => {
    if (!authorized(req, config)) return res.status(401).json({ error: 'Unauthorized' });
    return res.json(await actionEngine.reload());
  });

  const eventsHandler = (req, res) => {
    if (!sseRegistry.acquire()) {
      res.status(503).type('text/plain').send('Too many connections');
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    writeSse(res, 'connected', {
      at: new Date().toISOString(),
      state: bus.currentState(),
      health: bus.health(),
    });

    const listeners = {
      alert: (payload) => writeSse(res, 'alert', payload),
      'alert-update': (payload) => writeSse(res, 'alert-update', payload),
      state: (payload) => writeSse(res, 'state', payload),
      'source-status': (payload) => writeSse(res, 'source-status', payload),
      'action-delivery': (payload) => writeSse(res, 'action-delivery', payload),
    };
    for (const [name, listener] of Object.entries(listeners)) bus.on(name, listener);
    const heartbeat = setInterval(() => res.write(`: heartbeat ${Date.now()}\n\n`), 15_000);
    heartbeat.unref?.();

    let released = false;
    req.on('close', () => {
      if (released) return;
      released = true;
      sseRegistry.release();
      clearInterval(heartbeat);
      for (const [name, listener] of Object.entries(listeners)) bus.off(name, listener);
    });
  };
  app.get('/api/v1/events', eventsHandler);

  app.post('/api/v1/test-alert', (req, res) => {
    if (!config.enableTestEndpoint) return res.status(404).json({ error: 'Test endpoint disabled' });
    if (!authorized(req, config)) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body || {};
    const candidate = makeCandidate({
      source: 'manual-test',
      rawId: `test-${Date.now()}`,
      kind: body.kind || 'alert',
      category: Number(body.category || 1),
      title: body.title || 'בדיקת מערכת בלבד',
      instructions: body.instructions || 'זו אינה התרעת אמת',
      areas: Array.isArray(body.areas) && body.areas.length ? body.areas : ['אזור בדיקה'],
      occurredAt: new Date(),
      raw: { test: true, input: body },
      test: true,
    }, { ...config, includeDrills: true });
    const event = bus.publishCandidate(candidate);
    return res.status(202).json(event);
  });

  // ── 7-day ranking dashboard ─────────────────────────────────────────────
  // Route names and SSE event names are unchanged from v1 so the dashboard
  // and any existing consumers keep working.
  if (rankingEngine) {
    app.get('/api/alerts', async (_req, res) => {
      try {
        res.json(await rankingEngine.get());
      } catch (error) {
        logger.error({ err: error.message }, 'Ranking query failed');
        res.status(502).json({ error: 'Failed to fetch alert data' });
      }
    });
    app.get('/api/v1/rankings', async (_req, res) => {
      try {
        res.json(await rankingEngine.get());
      } catch (error) {
        logger.error({ err: error.message }, 'Ranking query failed');
        res.status(502).json({ error: 'Failed to fetch alert data' });
      }
    });

    app.get('/api/alerts/stream', (req, res) => {
      if (!sseRegistry.acquire()) {
        res.status(503).type('text/plain').send('Too many connections');
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        sseRegistry.release();
        rankingEngine.off('progress', onProgress);
        rankingEngine.off('update', onUpdate);
        rankingEngine.off('done', onDone);
      };

      // A fresh result needs no scan — hand it over and close.
      if (rankingEngine.isFresh()) {
        writeSse(res, 'done', rankingEngine.cache);
        release();
        res.end();
        return;
      }

      const onProgress = (payload) => writeSse(res, 'progress', payload);
      const onUpdate = (payload) => writeSse(res, 'update', payload);
      const onDone = (payload) => {
        writeSse(res, 'done', payload);
        release();
        res.end();
      };

      rankingEngine.on('progress', onProgress);
      rankingEngine.on('update', onUpdate);
      rankingEngine.on('done', onDone);
      req.on('close', release);

      rankingEngine.ensureQueryRunning();
    });
  }

  app.get('/metrics', (_req, res) => {
    const health = bus.health();
    const lines = [
      '# HELP oref_service_up Service health based on an official Oref source',
      '# TYPE oref_service_up gauge',
      `oref_service_up ${health.ok ? 1 : 0}`,
      '# HELP oref_active_areas Number of areas with active alerts',
      '# TYPE oref_active_areas gauge',
      `oref_active_areas ${health.state.activeCount}`,
      '# HELP oref_pre_alert_areas Number of areas with pre-alert state',
      '# TYPE oref_pre_alert_areas gauge',
      `oref_pre_alert_areas ${health.state.preAlertCount}`,
      '# HELP oref_events_total Correlated events created',
      '# TYPE oref_events_total counter',
      `oref_events_total ${health.metrics.newEvents}`,
      '# HELP oref_candidates_total Raw candidates accepted for processing',
      '# TYPE oref_candidates_total counter',
      `oref_candidates_total ${health.metrics.candidates}`,
    ];
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  app.get('/current', (_req, res) => {
    const current = compatibilityCurrent(bus);
    res.json({ alert: Boolean(current), current });
  });
  app.get('/history', (_req, res) => {
    res.json({
      history: bus.recent.map((event) => ({
        alertDate: event.occurredAt,
        title: event.title,
        data: event.areas,
        category: event.category,
        kind: event.kind,
        sources: event.sources,
      })),
    });
  });
  app.get('/health', healthHandler);
  app.get('/state', stateHandler);
  app.get('/sources', sourcesHandler);
  app.get('/alerts', alertsHandler);
  app.get('/events', eventsHandler);

  // Express's default 404 replaces the CSP with its own `default-src 'none'`,
  // which drops frame-ancestors. Answer unknown routes ourselves so every
  // response carries the app's headers.
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((error, _req, res, _next) => {
    logger.error({ err: error.message }, 'HTTP request failed');
    res.status(500).json({ error: 'Internal server error' });
  });

  app.locals.rateLimiter = rateLimiter;
  app.locals.sseRegistry = sseRegistry;
  return app;
}

export function startServer({ bus, actionEngine, rankingEngine = null, config, logger }) {
  const app = createApp({ bus, actionEngine, rankingEngine, config, logger });
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'Oref Command Center listening'));
  server.on('close', () => app.locals.rateLimiter.stop());
  return server;
}
