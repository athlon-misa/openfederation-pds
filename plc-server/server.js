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

run();
