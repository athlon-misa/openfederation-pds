const { PlcServer, Database } = require('@did-plc/server');
const express = require('express');
const demo = require('./demo-reset.js');

const run = async () => {
  // Demo mode (DEMO_MODE=true, docs/DEMO-SERVERS.md): wiped on a schedule.
  // Refuse to start when it is set where it must not be. Unset, nothing changes.
  const demoProblems = demo.demoStartupProblems(process.env);
  if (demoProblems.length > 0) {
    console.error('FATAL: DEMO_MODE is set, but this PLC directory must not be reset as a demo:');
    for (const problem of demoProblems) console.error(`  - ${problem}`);
    console.error('See docs/DEMO-SERVERS.md. Unset DEMO_MODE on any directory that is not a demo.');
    process.exit(1);
  }
  const demoMode = demo.readDemoConfig(process.env).enabled;

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
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // A JSON API: never framed, never sniffed, always over HTTPS.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // POST: a browser client (the dashboard's Move screen) submits an operation
    // the DID's own rotation key signed; the directory verifies every operation.
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // While a demo reset runs, every request gets 503 DemoResetting.
  if (demoMode) app.use(demo.resetGate);
  // The PLC library's own Express app adds the header too.
  if (typeof plc.app.disable === 'function') plc.app.disable('x-powered-by');
  app.use(plc.app);

  app.listen(port, () => {
    console.log(`PLC directory running on port ${port} with CORS enabled`);
    if (demoMode) {
      demo.startDemoResetScheduler({
        reset: () => demo.runDemoReset({
          endPoolOnFailure: true,
          getPool: () => {
            if (!dbUrl) return null;
            const { Pool } = require('pg');
            return new Pool({ connectionString: dbUrl, max: 1 });
          },
        }),
      });
    }
  });
};

run().catch((err) => {
  console.error('PLC directory failed to start:', err);
  process.exit(1);
});
