import { Router, type Request, type Response } from 'express';
import { handlerRegistry } from './handler-registry.js';
import type { AuthRequest } from '../auth/types.js';
import { enforceXrpcErrorResponses, renderXrpcError } from '../xrpc/errors.js';
import { validateXrpcInput } from '../lexicon/runtime.js';

export function createXrpcRouter(): Router {
  const router = Router();

  // XRPC Router - supports both GET and POST
  router.all('/:nsid', async (req: Request, res: Response) => {
    const nsid = req.params.nsid;

    if (!nsid || typeof nsid !== 'string') {
      return res.status(400).json({
        error: 'InvalidRequest',
        message: 'nsid parameter is required'
      });
    }

    try {
      const entry = handlerRegistry[nsid];

      if (!entry) {
        return res.status(404).json({
          error: 'MethodNotFound',
          message: 'XRPC method not found'
        });
      }

      if (entry.enabledWhen && !entry.enabledWhen()) {
        return res.status(501).json({
          error: 'MethodNotImplemented',
          message: 'XRPC method not implemented'
        });
      }

      // A deactivated account keeps a session (#265) but may only use it to
      // check on, fill, activate or back up the account. Status is read from
      // the database per request, so activation takes effect at once.
      const auth = (req as AuthRequest).auth;
      if (auth && auth.authMethod !== 'service-auth' && auth.status === 'deactivated' && !entry.whileDeactivated) {
        return res.status(403).json({
          error: 'AccountDeactivated',
          message: 'Your account is deactivated. Reactivate it with com.atproto.server.activateAccount to continue.',
        });
      }

      enforceXrpcErrorResponses(nsid, res);

      const validationTarget = req.method === 'GET' ? req.query : req.body ?? {};
      const validation = validateXrpcInput(nsid, validationTarget);
      if (!validation.ok) {
        return res.status(400).json({
          error: 'InvalidRequest',
          message: validation.message,
        });
      }

      // Apply endpoint-specific rate limiter if configured
      if (entry.limiter) {
        await new Promise<void>((resolve, reject) => {
          entry.limiter!(req, res, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });
        // If rate limiter already sent a response, don't continue
        if (res.headersSent) return;
      }

      await entry.handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        renderXrpcError(nsid, res, err);
      }
    }
  });

  return router;
}
