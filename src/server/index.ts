import express, { Request, Response } from 'express';
import { config } from '../config.js';
import { testConnection } from '../db/client.js';
import createCommunity from '../api/net.openfederation.community.create.js';
import getRecord from '../api/com.atproto.repo.getRecord.js';

const app = express();

// Middleware
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// XRPC Handler type
export type XRPCHandler = (req: Request, res: Response) => Promise<void> | void;

// Static handler registry to prevent path traversal and improve type safety
const handlers: Record<string, XRPCHandler> = {
  // Custom OpenFederation methods
  'net.openfederation.community.create': createCommunity,

  // Standard ATProto endpoints
  'com.atproto.repo.getRecord': getRecord,

  'com.atproto.repo.putRecord': async (req, res) => {
    // Placeholder - will be implemented in Phase 2
    res.status(501).json({ error: 'Not implemented yet' });
  },

  'com.atproto.sync.getRepo': async (req, res) => {
    // Placeholder - will be implemented in Phase 2
    res.status(501).json({ error: 'Not implemented yet' });
  },
};

// XRPC Router - supports both GET and POST
app.all('/xrpc/:nsid', async (req: Request, res: Response) => {
  const nsid = req.params.nsid;

  if (!nsid || typeof nsid !== 'string') {
    return res.status(400).json({
      error: 'InvalidRequest',
      message: 'nsid parameter is required'
    });
  }

  try {
    // Dispatch from static registry (prevents path traversal and improves type-safety)
    const handler = handlers[nsid];

    if (!handler) {
      return res.status(404).json({
        error: 'MethodNotFound',
        message: `XRPC method not found: ${nsid}`
      });
    }

    await handler(req, res);
  } catch (err) {
    console.error(`Error handling XRPC request for ${nsid}:`, err);
    res.status(500).json({
      error: 'InternalServerError',
      message: 'An internal error occurred'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OpenFederation PDS',
    version: '1.0.0',
    description: 'Personal Data Server for OpenFederation communities',
  });
});

// Register a new XRPC handler (used by other modules)
export function registerHandler(nsid: string, handler: XRPCHandler): void {
  handlers[nsid] = handler;
}

// Start the server
export async function startServer(): Promise<void> {
  // Test database connection before starting
  const dbConnected = await testConnection();
  if (!dbConnected) {
    throw new Error('Failed to connect to database');
  }

  return new Promise((resolve) => {
    app.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
      resolve();
    });
  });
}

export { app };
