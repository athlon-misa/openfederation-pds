import type { Response } from 'express';
import {
  assertDeclaredErrorCode,
  getMethodSchema,
  isDeclaredErrorCode,
  validateXrpcOutput,
} from '../lexicon/runtime.js';

const STANDARD_XRPC_ERROR_CODES = new Set([
  'InternalServerError',
  'InvalidRequest',
  'Unauthorized',
  'AuthRequired',
  'Forbidden',
  'RateLimitExceeded',
  'MethodNotFound',
  'AccountSuspended',
  'AccountTakenDown',
  'AccountDeactivated',
  'AccountNotApproved',
]);

export class XrpcError extends Error {
  readonly nsid: string;
  readonly code: string;
  readonly status: number;

  constructor(nsid: string, code: string, status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'XrpcError';
    this.nsid = nsid;
    this.code = code;
    this.status = status;
  }
}

export function throwXrpc(nsid: string, code: string, status: number, message: string): never {
  assertDeclaredErrorCode(nsid, code);
  throw new XrpcError(nsid, code, status, message);
}

export function isStandardXrpcErrorCode(code: string): boolean {
  return STANDARD_XRPC_ERROR_CODES.has(code);
}

export function isAllowedXrpcErrorCode(nsid: string, code: string): boolean {
  if (!getMethodSchema(nsid)) return true;
  return isStandardXrpcErrorCode(code) || isDeclaredErrorCode(nsid, code);
}

export function assertAllowedXrpcErrorCode(nsid: string, code: string): void {
  if (!isAllowedXrpcErrorCode(nsid, code)) {
    throw new Error(`XRPC error "${code}" is not declared by lexicon "${nsid}"`);
  }
}

export function enforceXrpcErrorResponses(nsid: string, res: Response): void {
  const originalJson = res.json.bind(res);

  res.json = ((body?: unknown) => {
    if (isErrorBody(body)) {
      try {
        assertAllowedXrpcErrorCode(nsid, body.error);
      } catch (validationError) {
        console.error(`Undeclared XRPC error response from ${nsid}:`, validationError);
        res.status(500);
        return originalJson({
          error: 'InternalServerError',
          message: 'An internal error occurred',
        });
      }
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      const validation = validateXrpcOutput(nsid, body);
      if (!validation.ok) {
        console.error(`Invalid XRPC output from ${nsid}: ${validation.message}`);
        res.status(500);
        return originalJson({
          error: 'InternalServerError',
          message: 'An internal error occurred',
        });
      }
    }
    return originalJson(body);
  }) as Response['json'];
}

export function renderXrpcError(nsid: string, res: Response, error: unknown): void {
  if (error instanceof XrpcError) {
    try {
      assertAllowedXrpcErrorCode(error.nsid, error.code);
    } catch (validationError) {
      console.error(`Undeclared XRPC error from ${error.nsid}:`, validationError);
      res.status(500).json({
        error: 'InternalServerError',
        message: 'An internal error occurred',
      });
      return;
    }

    res.status(error.status).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  console.error(`Error handling XRPC request for ${nsid}:`, error);
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An internal error occurred',
  });
}

function isErrorBody(body: unknown): body is { error: string; message?: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error?: unknown }).error === 'string'
  );
}
