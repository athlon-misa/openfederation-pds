import { startServer } from './server/index.js';
import { config } from './config.js';

async function main() {
  try {
    console.log('Starting OpenFederation PDS...');
    console.log(`Configuration:`);
    console.log(`  - Port: ${config.port}`);
    console.log(`  - PDS Service URL: ${config.pds.serviceUrl}`);
    console.log(`  - Database: ${config.database.host}:${config.database.port}/${config.database.database}`);

    await startServer();

    console.log(`OpenFederation PDS is running on port ${config.port}`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
