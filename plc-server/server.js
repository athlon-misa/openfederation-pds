const { PlcServer, Database } = require('@did-plc/server');
const express = require('express');

const run = async () => {
  const dbUrl = process.env.DATABASE_URL;
  let db;
  if (dbUrl) {
    const pgDb = Database.postgres({ url: dbUrl });
    await pgDb.migrateToLatestOrThrow();
    db = pgDb;
  } else {
    // Without a database every did:plc lives in memory and is gone on restart,
    // which makes every identity registered here unresolvable. That is fine for
    // local development and must never happen by accident on a deployment
    // (a missing or misnamed variable used to produce exactly that, silently).
    const deployed = process.env.NODE_ENV === 'production'
      || !!process.env.RAILWAY_ENVIRONMENT
      || !!process.env.RAILWAY_ENVIRONMENT_NAME;
    if (deployed && process.env.PLC_ALLOW_IN_MEMORY !== 'true') {
      console.error('FATAL: DATABASE_URL is not set. Refusing to run the PLC directory in memory on a deployment.');
      console.error('Set DATABASE_URL, or PLC_ALLOW_IN_MEMORY=true if a throwaway directory is really intended.');
      process.exit(1);
    }
    console.warn('WARNING: DATABASE_URL is not set. PLC directory is running IN MEMORY; all DIDs are lost on restart.');
    db = Database.mock();
  }

  const envPort = parseInt(process.env.PORT || '');
  const port = isNaN(envPort) ? 2582 : envPort;
  const plc = PlcServer.create({ db, port });

  // Wrap with CORS so browsers can resolve DIDs
  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(plc.app);

  app.listen(port, () => {
    console.log(`PLC directory running on port ${port} with CORS enabled`);
  });
};

run().catch((err) => {
  console.error('PLC directory failed to start:', err);
  process.exit(1);
});
