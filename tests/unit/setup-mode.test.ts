/**
 * When the server starts in setup mode (#405), and that installs configured
 * with environment variables start exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { decideStartMode } from '../../src/setup/mode.js';

const SECRETS = { AUTH_JWT_SECRET: 'a'.repeat(64), KEY_ENCRYPTION_SECRET: 'b'.repeat(64) };

describe('decideStartMode', () => {
  it('a production install configured by environment variables starts normally', () => {
    expect(decideStartMode({ NODE_ENV: 'production', ...SECRETS }, false).mode).toBe('normal');
  });

  it('development without secrets starts normally, as before (with its warnings)', () => {
    expect(decideStartMode({ NODE_ENV: 'development' }, false).mode).toBe('normal');
    expect(decideStartMode({}, false).mode).toBe('normal');
    expect(decideStartMode({ NODE_ENV: 'test' }, false).mode).toBe('normal');
  });

  it('a production install with no secrets at all is a fresh install: setup mode', () => {
    expect(decideStartMode({ NODE_ENV: 'production' }, false).mode).toBe('setup');
    expect(decideStartMode({ NODE_ENV: 'production', AUTH_JWT_SECRET: '  ', KEY_ENCRYPTION_SECRET: '' }, false).mode).toBe('setup');
  });

  it('a half-configured production install keeps the old refusal instead of a wizard', () => {
    expect(decideStartMode({ NODE_ENV: 'production', AUTH_JWT_SECRET: SECRETS.AUTH_JWT_SECRET }, false).mode).toBe('normal');
    expect(decideStartMode({ NODE_ENV: 'production', KEY_ENCRYPTION_SECRET: SECRETS.KEY_ENCRYPTION_SECRET }, false).mode).toBe('normal');
  });

  it('never again once the settings file exists', () => {
    expect(decideStartMode({ NODE_ENV: 'production' }, true).mode).toBe('normal');
    expect(decideStartMode({ OPENFEDERATION_SETUP: 'on' }, true).mode).toBe('normal');
  });

  it('OPENFEDERATION_SETUP=on asks for it anywhere; =off refuses it everywhere', () => {
    expect(decideStartMode({ OPENFEDERATION_SETUP: 'on' }, false).mode).toBe('setup');
    expect(decideStartMode({ OPENFEDERATION_SETUP: 'on', NODE_ENV: 'production', ...SECRETS }, false).mode).toBe('setup');
    expect(decideStartMode({ OPENFEDERATION_SETUP: 'off', NODE_ENV: 'production' }, false).mode).toBe('normal');
  });
});
