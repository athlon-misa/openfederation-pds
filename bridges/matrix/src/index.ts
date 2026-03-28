import { loadConfig } from './config.js';
import { PDSClient } from './pds-client.js';
import { MatrixClient } from './matrix-client.js';
import { SyncEngine } from './sync.js';

const CONFIG_PATH = process.argv[2] || './config.json';

async function main() {
  console.log('[Bridge] Loading config from', CONFIG_PATH);
  const config = loadConfig(CONFIG_PATH);

  console.log(`[Bridge] Mode: ${config.mode}`);
  console.log(`[Bridge] PDS: ${config.pdsUrl}`);
  console.log(`[Bridge] Matrix: ${config.matrix.homeserverUrl}`);
  console.log(`[Bridge] Communities: ${config.communityMappings.length}`);

  const pds = new PDSClient(config.pdsUrl);
  await pds.login(config.pdsAuth.handle, config.pdsAuth.password);

  const matrix = new MatrixClient(config.matrix.homeserverUrl, config.matrix.adminToken);

  const sync = new SyncEngine(pds, matrix, config);

  console.log('[Bridge] Running initial sync...');
  await sync.syncAll();

  console.log(`[Bridge] Starting sync loop (interval: ${config.syncIntervalMs}ms)`);
  setInterval(() => {
    sync.syncAll().catch(err => {
      console.error('[Bridge] Sync error:', err);
    });
  }, config.syncIntervalMs);
}

main().catch(err => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});
