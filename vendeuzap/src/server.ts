import { assertProductionConfig, config } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { startDispatcher } from './dispatcher.js';

assertProductionConfig();
const db = openDb();
const app = await buildApp(db, { logger: true });
const stop = startDispatcher(db, config.dispatcherIntervalMs, (m) => app.log.info(m));

await app.listen({ port: config.port, host: config.host });
app.log.info(`Vendeuzap em ${config.baseUrl}${config.dryRun ? ' (DRY_RUN: eventos não são enviados)' : ''}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
