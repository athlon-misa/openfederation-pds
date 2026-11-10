import { Router, type Request, type Response } from 'express';
import { handlerRegistry } from './handler-registry.js';
import type { AuthRequest } from '../auth/types.js';
import { enforceXrpcErrorResponses, renderXrpcError } from '../xrpc/errors.js';
import { getMethodSchema, validateXrpcInput } from '../lexicon/runtime.js';

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
      // An own-property lookup: `handlerRegistry['constructor']` is truthy
      // for any plain object and used to be "found", then fail as a 500.
      const entry = Object.hasOwn(handlerRegistry, nsid) ? handlerRegistry[nsid] : undefined;

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
      // This includes a service-auth token signed for a local account: its
      // context carries the local status. A remote caller has no status here.
      if (auth && auth.status === 'deactivated' && !entry.whileDeactivated) {
        return res.status(403).json({
          error: 'AccountDeactivated',
          message: 'Your account is deactivated. Reactivate it with com.atproto.server.activateAccount to continue.',
        });
      }

      // An account that is not approved (a pending sign-up, or rejected) gets
      // nothing either. Local login already refuses these; this is what stops
      // an OAuth grant or a service-auth token from acting for them.
      if (auth && (auth.status === 'pending' || auth.status === 'rejected')) {
        return res.status(403).json({
          error: 'AccountNotApproved',
          message: 'This account has not been approved yet.',
        });
      }

      // A suspended or taken-down account gets nothing, whichever credential
      // it presents. Local sessions are already dead by then (the status change
      // bumps token_version); this is what stops an OAuth grant or a
      // service-auth token signed with the account's key, neither of which the
      // status change invalidates.
      if (auth && (auth.status === 'suspended' || auth.status === 'takendown')) {
        return auth.status === 'suspended'
          ? res.status(403).json({ error: 'AccountSuspended', message: 'Your account has been suspended.' })
          : res.status(410).json({ error: 'AccountTakenDown', message: 'Your account has been taken down.' });
      }

      // What the method is comes from its lexicon, not from the verb it was
      // called with. A procedure changes state and is refused on GET (a link,
      // a prefetch or a crawler must not be able to trigger one). A query's
      // declared parameters live in the query string whichever verb carried
      // them, so that is what gets validated.
      const methodType = getMethodSchema(nsid)?.defs?.main?.type;
      if (methodType === 'procedure' && req.method === 'GET') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({
          error: 'InvalidRequest',
          message: 'This method is a procedure and must be called with POST',
        });
      }

      enforceXrpcErrorResponses(nsid, res);

      const validationTarget = (methodType ? methodType === 'query' : req.method === 'GET')
        ? req.query
        : req.body ?? {};
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
