// Configuration is read once, when src/config.ts is first imported. A fresh
// install has none yet, so the settings file and, when needed, the setup
// wizard come first, and the server is imported only after them (#405).
import dotenv from 'dotenv';
import { loadSettingsFile, runSetupIfNeeded } from './setup/launcher.js';

async function main() {
  try {
    dotenv.config({ quiet: true });
    loadSettingsFile(process.env);
    await runSetupIfNeeded(process.env);

    const { config } = await import('./config.js');
    const { startServer, releaseServerResources } = await import('./server/index.js');
    const { gracefulShutdown } = await import('./server/shutdown.js');
    /** How long requests already running get to finish once a stop is asked for. */
    const SHUTDOWN_TIMEOUT_MS = Math.max(1, parseInt(process.env.SHUTDOWN_TIMEOUT_SECONDS || '20', 10) || 20) * 1000;

    console.log('Starting OpenFederation PDS...');
    console.log(`Configuration:`);
    console.log(`  - Port: ${config.port}`);
    console.log(`  - PDS Service URL: ${config.pds.serviceUrl}`);
    console.log(`  - Database: ${config.database.host}:${config.database.port}/${config.database.database}`);

    const server = await startServer();

    console.log(`OpenFederation PDS is running on port ${config.port}`);

    // A deploy or restart sends SIGTERM. Finish what is in flight, then let go
    // of the database, instead of dying mid-request.
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received: finishing requests in flight (up to ${SHUTDOWN_TIMEOUT_MS / 1000}s)...`);
      gracefulShutdown(server, { timeoutMs: SHUTDOWN_TIMEOUT_MS, cleanup: releaseServerResources })
        .then((outcome) => {
          console.log(outcome === 'clean' ? 'Shutdown complete.' : 'Shutdown timed out waiting for requests; exiting.');
          process.exit(outcome === 'clean' ? 0 : 1);
        })
        .catch((err) => {
          console.error('Error during shutdown:', err);
          process.exit(1);
        });
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
