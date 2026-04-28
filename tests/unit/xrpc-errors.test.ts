import { describe, it, expect, vi } from 'vitest';
import {
  assertDeclaredErrorCode,
  getDeclaredErrorCodes,
} from '../../src/lexicon/runtime.js';
import {
  enforceXrpcErrorResponses,
  renderXrpcError,
  throwXrpc,
  XrpcError,
} from '../../src/xrpc/errors.js';

describe('XRPC lexicon-declared errors', () => {
  it('loads declared error codes for community.join', () => {
    const errors = getDeclaredErrorCodes('net.openfederation.community.join');

    expect(errors.has('AlreadyMember')).toBe(true);
    expect(errors.has('AlreadyRequested')).toBe(true);
    expect(errors.has('PayloadTooLarge')).toBe(true);
  });

  it('rejects undeclared error codes', () => {
    expect(() =>
      assertDeclaredErrorCode('net.openfederation.community.join', 'TypoedError'),
    ).toThrow(/not declared/);
  });

  it('throwXrpc only throws declared XrpcError instances', () => {
    expect(() =>
      throwXrpc(
        'net.openfederation.community.join',
        'AlreadyMember',
        409,
        'You are already a member',
      ),
    ).toThrow(XrpcError);

    expect(() =>
      throwXrpc('net.openfederation.community.join', 'TypoedError', 400, 'Nope'),
    ).toThrow(/not declared/);
  });

  it('renders declared XrpcError responses with the existing response shape', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status } as any;

    renderXrpcError(
      'net.openfederation.community.join',
      res,
      new XrpcError(
        'net.openfederation.community.join',
        'AlreadyRequested',
        409,
        'You already have a pending join request',
      ),
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: 'AlreadyRequested',
      message: 'You already have a pending join request',
    });
  });

  it('guards inline handler error responses against undeclared codes', () => {
    const json = vi.fn();
    const status = vi.fn(() => res);
    const res = { status, json } as any;

    enforceXrpcErrorResponses('net.openfederation.community.join', res);
    res.status(409).json({ error: 'TypoedError', message: 'Nope' });

    expect(status).toHaveBeenLastCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'InternalServerError',
      message: 'An internal error occurred',
    });
  });

  it('allows shared transport errors from inline handler responses', () => {
    const json = vi.fn();
    const status = vi.fn(() => res);
    const res = { status, json } as any;

    enforceXrpcErrorResponses('net.openfederation.community.join', res);
    res.status(401).json({ error: 'Unauthorized', message: 'Missing access token' });

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: 'Unauthorized',
      message: 'Missing access token',
    });
  });

  it('guards successful handler output against lexicon shape drift', () => {
    const json = vi.fn();
    const status = vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    });
    const res = { statusCode: 200, status, json } as any;

    enforceXrpcErrorResponses('net.openfederation.community.join', res);
    res.status(200).json({ state: 'joined' });

    expect(status).toHaveBeenLastCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'InternalServerError',
      message: 'An internal error occurred',
    });
  });
});
