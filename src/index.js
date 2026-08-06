import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as defaultConfig } from './config.js';
import { logger as defaultLogger } from './logger.js';
import { AreaCatalog } from './metadata/area-catalog.js';
import { EventStore } from './storage/event-store.js';
import { AlertBus } from './core/alert-bus.js';
import { ActionEngine } from './actions/action-engine.js';
import { RankingEngine } from './rankings/ranking-engine.js';
import { OfficialRealtimeSource } from './sources/official-realtime.js';
import { OfficialHistorySource } from './sources/official-history.js';
import { OfficialExtendedHistorySource } from './sources/official-extended-history.js';
import { TzevaAdomWsSource } from './sources/tzevaadom-ws.js';
import { PushyMobileSource } from './sources/pushy-mobile.js';
import { createApp, startServer } from './server.js';

process.env.TZ = defaultConfig.timezone;

/**
 * Wires the alert pipeline without starting any source polling, opening a port
 * or contacting Oref. `main()` builds on this; tests use it directly to get a
 * real app with no live traffic.
 */
export async function buildRuntime({ config = defaultConfig, logger = defaultLogger } = {}) {
  const eventStore = new EventStore(config.dataDir, (error) => logger.error({ err: error.message }, 'Snapshot persistence failed'));
  await eventStore.init();
  const snapshot = await eventStore.loadSnapshot();

  const areaCatalog = new AreaCatalog(config, logger);
  await areaCatalog.init();

  const bus = new AlertBus({ config, logger, eventStore, areaCatalog });
  bus.restore(snapshot);

  const actionEngine = new ActionEngine({
    config,
    logger,
    onDelivery: (delivery) => bus.addDelivery(delivery),
  });
  await actionEngine.init(snapshot.deliveries);
  bus.on('alert', (event) => void actionEngine.handle(event));
  bus.on('alert-update', (event) => void actionEngine.handle(event, { isUpdate: true }));

  const rankingEngine = config.enableRankings ? new RankingEngine({ config, logger }) : null;

  const sources = [
    new OfficialRealtimeSource({ bus, config, logger }),
    new OfficialHistorySource({ bus, config, logger }),
    new OfficialExtendedHistorySource({ bus, config, logger }),
  ];
  if (config.enableTzevaAdom) sources.push(new TzevaAdomWsSource({ bus, config, logger }));
  if (config.enablePushy) sources.push(new PushyMobileSource({ bus, config, logger, areaCatalog }));

  return { bus, actionEngine, rankingEngine, sources, areaCatalog, eventStore, config, logger };
}

/** Build an Express app with no live sources attached — used by the tests. */
export async function createTestApp(overrides = {}) {
  const runtime = await buildRuntime(overrides);
  const app = createApp(runtime);
  return { app, ...runtime };
}

async function main() {
  const runtime = await buildRuntime();
  const { bus, actionEngine, rankingEngine, sources, config, logger } = runtime;

  const server = startServer({ bus, actionEngine, rankingEngine, config, logger });
  for (const source of sources) await source.start();
  rankingEngine?.start();

  const stateCleanup = setInterval(() => bus.cleanup(), 5000);
  stateCleanup.unref?.();

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    clearInterval(stateCleanup);
    rankingEngine?.stop();
    for (const source of sources) {
      try {
        await source.stop();
      } catch (error) {
        logger.error({ source: source.name, err: error.message }, 'Source shutdown failed');
      }
    }
    actionEngine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => logger.error({ err: error }, 'Unhandled rejection'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) await main();
