/**
 * Demo mode (docs/DEMO-SERVERS.md): the parts that need no database — the
 * schedule, the guards, the settings a demo server starts with, and the timer.
 * The wipe itself is tests/api/demo-reset.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseCron, nextCronRun } from '../../src/demo/cron.js';
import {
  readDemoConfig, demoGuardProblems, demoPublicInfo, startDemoResetScheduler, stopDemoResetScheduler,
  PRODUCTION_PLC_HOSTS, type DemoGuardInput,
} from '../../src/demo/demo-mode.js';
import { resolveRuntimeSettings } from '../../src/settings/runtime-settings.js';

const at = (iso: string) => new Date(iso);

describe('the reset schedule (cron, UTC)', () => {
  it('runs a daily schedule at the next matching minute, in UTC', () => {
    const daily = parseCron('0 3 * * *');
    expect(nextCronRun(daily, at('2026-11-15T02:59:30Z')).toISOString()).toBe('2026-11-15T03:00:00.000Z');
    expect(nextCronRun(daily, at('2026-11-15T03:00:00Z')).toISOString()).toBe('2026-11-16T03:00:00.000Z');
    expect(nextCronRun(daily, at('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('understands lists, ranges and steps', () => {
    expect(nextCronRun(parseCron('*/15 * * * *'), at('2026-11-15T10:07:00Z')).toISOString()).toBe('2026-11-15T10:15:00.000Z');
    expect(nextCronRun(parseCron('30 1,13 * * *'), at('2026-11-15T02:00:00Z')).toISOString()).toBe('2026-11-15T13:30:00.000Z');
    // Weekdays only: 2026-11-14 is a Saturday, so Monday the 16th.
    expect(nextCronRun(parseCron('0 3 * * 1-5'), at('2026-11-14T12:00:00Z')).toISOString()).toBe('2026-11-16T03:00:00.000Z');
    // Sunday as 7 as well as 0.
    expect(nextCronRun(parseCron('0 0 * * 7'), at('2026-11-14T12:00:00Z')).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(nextCronRun(parseCron('0 0 1 * *'), at('2026-11-15T00:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('refuses what it does not understand, instead of guessing when to wipe', () => {
    for (const bad of ['', '0 3 * *', '0 3 * * * *', '60 3 * * *', '0 24 * * *', 'a b c d e', '0 3 32 * *', '*/0 * * * *', '5-1 * * * *', '@daily']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });
});

describe('the demo configuration (environment only)', () => {
  it('is off unless DEMO_MODE=true, with a 03:00 UTC default schedule', () => {
    expect(readDemoConfig({}).enabled).toBe(false);
    expect(readDemoConfig({ DEMO_MODE: 'false' }).enabled).toBe(false);
    const on = readDemoConfig({ DEMO_MODE: 'true' });
    expect(on.enabled).toBe(true);
    expect(on.resetSchedule).toBe('0 3 * * *');
    expect(readDemoConfig({ DEMO_MODE: 'true', DEMO_RESET_SCHEDULE: '30 4 * * *' }).resetSchedule).toBe('30 4 * * *');
  });

  it('stops on a DEMO_MODE value it cannot read, and on a bad schedule', () => {
    expect(() => readDemoConfig({ DEMO_MODE: 'yes' })).toThrow(/DEMO_MODE/);
    expect(() => readDemoConfig({ DEMO_MODE: 'true', DEMO_RESET_SCHEDULE: 'nightly' })).toThrow(/DEMO_RESET_SCHEDULE/);
  });
});

describe('the guards', () => {
  const ok: DemoGuardInput = {
    plcDirectoryUrl: 'https://plc.demo.openfederation.net',
    pdsHostname: 'demo.openfederation.net',
    pdsServiceUrl: 'https://demo.openfederation.net',
    allowedHostname: '',
    blobStorage: 'local',
    blobPath: '/data/blobs',
    cwd: '/app',
    home: '/root',
  };

  it('pass for a demo PDS with its own demo PLC directory', () => {
    expect(demoGuardProblems(ok)).toEqual([]);
    expect(demoGuardProblems({ ...ok, pdsHostname: 'demo.opennewsrooms.com', pdsServiceUrl: 'https://demo.opennewsrooms.com' })).toEqual([]);
  });

  it('refuse the production PLC directories, however they are written', () => {
    expect(PRODUCTION_PLC_HOSTS).toEqual(expect.arrayContaining(['plc.openfederation.net', 'plc.directory']));
    for (const url of ['https://plc.openfederation.net', 'https://PLC.openfederation.net/', 'http://plc.openfederation.net:443/x', 'https://plc.directory', 'https://plc.directory.']) {
      expect(demoGuardProblems({ ...ok, plcDirectoryUrl: url }).join(' '), url).toMatch(/PLC_DIRECTORY_URL/);
    }
    expect(demoGuardProblems({ ...ok, plcDirectoryUrl: 'not a url' }).join(' ')).toMatch(/PLC_DIRECTORY_URL/);
  });

  it('refuse a hostname without "demo" in it, unless DEMO_ALLOWED_HOSTNAME names it', () => {
    const prod = { ...ok, pdsHostname: 'pds.openfederation.net', pdsServiceUrl: 'https://pds.openfederation.net' };
    expect(demoGuardProblems(prod).join(' ')).toMatch(/PDS_HOSTNAME/);
    expect(demoGuardProblems({ ...ok, pdsHostname: 'sandbox.example.org', pdsServiceUrl: 'https://sandbox.example.org' }).join(' ')).toMatch(/PDS_HOSTNAME/);
    expect(demoGuardProblems({ ...ok, pdsHostname: 'sandbox.example.org', pdsServiceUrl: 'https://sandbox.example.org', allowedHostname: 'sandbox.example.org' })).toEqual([]);
    // The allowance is exact: it does not let another host through.
    expect(demoGuardProblems({ ...ok, pdsHostname: 'other.example.org', pdsServiceUrl: 'https://other.example.org', allowedHostname: 'sandbox.example.org' }).join(' ')).toMatch(/PDS_HOSTNAME/);
  });

  it('refuse a service URL that is not this demo host (the URL every DID created here points at)', () => {
    expect(demoGuardProblems({ ...ok, pdsServiceUrl: 'https://pds.openfederation.net' }).join(' ')).toMatch(/PDS_SERVICE_URL/);
  });

  it('refuse S3 blob storage', () => {
    expect(demoGuardProblems({ ...ok, blobStorage: 's3' }).join(' ')).toMatch(/BLOB_STORAGE/);
  });

  it('refuse a blob directory that would take more than the blobs with it', () => {
    for (const blobPath of ['/', '/app', '/root', '/']) {
      expect(demoGuardProblems({ ...ok, blobPath }).join(' '), blobPath).toMatch(/BLOB_STORAGE_PATH/);
    }
    expect(demoGuardProblems({ ...ok, blobPath: '/app/data/blobs' })).toEqual([]);
  });

  it('allow NODE_ENV=production: a demo server is a production deployment', () => {
    expect(demoGuardProblems(ok)).toEqual([]);
  });
});

describe('the settings a demo server starts with', () => {
  it('opens the door: no invites, automatic approval, no email checks, pen names, device signing, open migration', () => {
    const s = resolveRuntimeSettings({ DEMO_MODE: 'true' }, {}, {}).settings;
    expect(s.inviteRequired).toBe(false);
    expect(s.accountApproval).toBe('automatic');
    expect(s.emailVerificationPolicy).toBe('off');
    expect(s.identity.pseudonymsEnabled).toBe(true);
    expect(s.identity.deviceSigningAllowed).toBe(true);
    expect(s.identity.custodyAllowed).toEqual(['custodial', 'assisted', 'self']);
    expect(s.migration).toEqual({ accounts: 'open', pseudonyms: 'open', communities: 'open' });
  });

  it('also over a profile, which is a lower default', () => {
    const s = resolveRuntimeSettings({ DEMO_MODE: 'true', OPENFEDERATION_PROFILE: 'community' }, {}, {}).settings;
    expect(s.identity.pseudonymsEnabled).toBe(true);
  });

  it('an explicit environment variable still wins', () => {
    const r = resolveRuntimeSettings({ DEMO_MODE: 'true', INVITE_REQUIRED: 'true', MIGRATION_ACCOUNTS: 'closed' }, {}, {});
    expect(r.settings.inviteRequired).toBe(true);
    expect(r.settings.migration.accounts).toBe('closed');
    expect(r.sources.inviteRequired).toBe('environment');
  });

  it('change nothing without demo mode', () => {
    const s = resolveRuntimeSettings({}, {}, {}).settings;
    expect(s.inviteRequired).toBe(true);
    expect(s.accountApproval).toBe('manual');
    expect(s.migration.accounts).toBe('invite');
  });
});

describe('the public flag', () => {
  it('says when the next reset is', () => {
    expect(demoPublicInfo({}, at('2026-11-15T10:00:00Z'))).toEqual({ enabled: false });
    expect(demoPublicInfo({ DEMO_MODE: 'true' }, at('2026-11-15T10:00:00Z'))).toEqual({
      enabled: true, resetSchedule: '0 3 * * *', nextResetAt: '2026-11-16T03:00:00.000Z',
    });
  });
});

describe('the timer', () => {
  afterEach(() => { stopDemoResetScheduler(); vi.useRealTimers(); });

  it('runs the reset at the scheduled minute, not before', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-15T02:58:00Z'));
    const reset = vi.fn(async () => {});
    startDemoResetScheduler({ env: { DEMO_MODE: 'true' }, reset });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('copes with a schedule further away than setTimeout can wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-15T12:00:00Z'));
    const reset = vi.fn(async () => {});
    // The first of the month: about two weeks out, re-armed every hour on the way.
    startDemoResetScheduler({ env: { DEMO_MODE: 'true', DEMO_RESET_SCHEDULE: '0 3 1 * *' }, reset });
    await vi.advanceTimersByTimeAsync(14 * 86_400_000);
    expect(reset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('never starts without demo mode', async () => {
    vi.useFakeTimers();
    const reset = vi.fn(async () => {});
    expect(startDemoResetScheduler({ env: {}, reset })).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(reset).not.toHaveBeenCalled();
  });
});
