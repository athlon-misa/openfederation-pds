/**
 * Pen-name passes outside the browser (dashboard): the saved file and the
 * printed text. Round trip, version, expiry with the monthly key rotation,
 * the checksum on the printed text, and refusing another server's passes.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPassFile, parsePassFile, parsePassText, parsePasses, passToText, groupText, passExpiry, isExpired,
  keyFingerprint, passId, PassFileError, PASS_FILE_FORMAT, PASS_FILE_VERSION,
  type Pass,
} from '../../web-interface/src/lib/pen-names/pass-file.js';

const SERVER = 'https://pds.example.org';
const OWNER = 'did:plc:abcdefghijklmnopqrstuvwx';
const b64 = (n: number, c: string) => c.repeat(n);
const pass = (epoch: string, c = 'A'): Pass => ({ epoch, prepared: b64(86, c), signature: b64(342, c), key: '0123456789abcdef' });
const NOV = new Date('2026-11-14T12:00:00Z');

function problem(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof PassFileError) return e.problem; throw e; }
  throw new Error('did not throw');
}

describe('expiry follows the monthly key rotation', () => {
  it('a pass works in its month and the next, then expires', () => {
    expect(passExpiry('2026-11').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(passExpiry('2026-12').toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(passExpiry('2026-01').toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(isExpired({ epoch: '2026-10' }, NOV)).toBe(false);
    expect(isExpired({ epoch: '2026-09' }, NOV)).toBe(true);
    expect(isExpired({ epoch: '2026-11' }, new Date('2026-12-31T23:59:59Z'))).toBe(false);
    expect(isExpired({ epoch: '2026-11' }, new Date('2027-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('pass file', () => {
  it('round-trips, with version, server, owner, key and expiry', () => {
    const file = buildPassFile({ server: `${SERVER}/`, owner: OWNER, passes: [pass('2026-11'), pass('2026-10', 'B')], now: NOV });
    expect(file.format).toBe(PASS_FILE_FORMAT);
    expect(file.version).toBe(PASS_FILE_VERSION);
    expect(file.server).toBe(SERVER);
    expect(file.passes[0].expires).toBe('2027-01-01T00:00:00.000Z');
    expect(file.passes[0].key).toBe('0123456789abcdef');
    expect(file.warning).toMatch(/cannot link/);
    const loaded = parsePassFile(JSON.stringify(file), { server: SERVER, now: NOV });
    expect(loaded.owner).toBe(OWNER);
    expect(loaded.passes).toEqual([pass('2026-11'), pass('2026-10', 'B')]);
    expect(loaded.expired).toBe(0);
  });

  it('leaves expired passes out when saving and loading', () => {
    expect(buildPassFile({ server: SERVER, owner: OWNER, passes: [pass('2026-09'), pass('2026-11')], now: NOV }).passes).toHaveLength(1);
    const file = buildPassFile({ server: SERVER, owner: OWNER, passes: [pass('2026-11'), pass('2026-12', 'B')], now: NOV });
    const later = parsePassFile(JSON.stringify(file), { server: SERVER, now: new Date('2027-01-05T00:00:00Z') });
    expect(later.passes.map((p) => p.epoch)).toEqual(['2026-12']);
    expect(later.expired).toBe(1);
    expect(problem(() => parsePassFile(JSON.stringify(file), { server: SERVER, now: new Date('2027-03-01T00:00:00Z') }))).toBe('AllExpired');
  });

  it('refuses another server’s passes', () => {
    const file = buildPassFile({ server: 'https://other.example', owner: OWNER, passes: [pass('2026-11')], now: NOV });
    expect(problem(() => parsePassFile(JSON.stringify(file), { server: SERVER, now: NOV }))).toBe('OtherServer');
  });

  it('refuses a newer version, something that is not a pass file, and a damaged one', () => {
    const file = buildPassFile({ server: SERVER, owner: OWNER, passes: [pass('2026-11')], now: NOV });
    expect(problem(() => parsePassFile(JSON.stringify({ ...file, version: PASS_FILE_VERSION + 1 }), { server: SERVER }))).toBe('NewerVersion');
    expect(problem(() => parsePassFile('not json', { server: SERVER }))).toBe('NotPassFile');
    expect(problem(() => parsePassFile(JSON.stringify({ format: 'something-else' }), { server: SERVER }))).toBe('NotPassFile');
    const bad = { ...file, passes: [{ ...file.passes[0], signature: 'not base64url!' }] };
    expect(problem(() => parsePassFile(JSON.stringify(bad), { server: SERVER, now: NOV }))).toBe('Damaged');
    expect(problem(() => parsePassFile(JSON.stringify({ ...file, owner: 'nobody' }), { server: SERVER, now: NOV }))).toBe('Damaged');
  });

  it('drops a pass listed twice', () => {
    const file = buildPassFile({ server: SERVER, owner: OWNER, passes: [pass('2026-11'), pass('2026-11')], now: NOV });
    expect(parsePassFile(JSON.stringify(file), { server: SERVER, now: NOV }).passes).toHaveLength(1);
  });
});

describe('printed pass text', () => {
  const text = passToText(pass('2026-11'), { server: SERVER, owner: OWNER });

  it('round-trips, and is read back through spaces and line breaks', () => {
    expect(text.startsWith(`ofpass1~${SERVER}~${OWNER}~2026-11~`)).toBe(true);
    const back = parsePassText(groupText(text).replace(/ (?=\S{8} \S{8} \S{8} )/g, '\n'), { server: SERVER, now: NOV });
    expect(back.owner).toBe(OWNER);
    expect(back.passes).toEqual([{ epoch: '2026-11', prepared: pass('2026-11').prepared, signature: pass('2026-11').signature }]);
    expect(parsePasses(text, { server: SERVER, now: NOV }).passes).toHaveLength(1);
  });

  it('says how long it is (the QR code is the practical paper form)', () => {
    expect(text.length).toBeGreaterThan(450);
    expect(text.length).toBeLessThan(560);
  });

  it('catches a wrong or missing character with its checksum', () => {
    const i = text.indexOf('AAAA');
    const typo = `${text.slice(0, i)}B${text.slice(i + 1)}`;
    expect(problem(() => parsePassText(typo, { server: SERVER, now: NOV }))).toBe('Checksum');
    const dropped = `${text.slice(0, i)}${text.slice(i + 1)}`;
    expect(problem(() => parsePassText(dropped, { server: SERVER, now: NOV }))).toBe('Checksum');
    expect(problem(() => parsePassText(text.split('~').slice(0, 5).join('~'), { server: SERVER, now: NOV }))).toBe('Damaged');
    expect(problem(() => parsePassText('hello', { server: SERVER, now: NOV }))).toBe('NotPassFile');
  });

  it('refuses another server’s pass, and an expired one', () => {
    const other = passToText(pass('2026-11'), { server: 'https://other.example', owner: OWNER });
    expect(problem(() => parsePassText(other, { server: SERVER, now: NOV }))).toBe('OtherServer');
    const old = passToText(pass('2026-08'), { server: SERVER, owner: OWNER });
    expect(problem(() => parsePassText(old, { server: SERVER, now: NOV }))).toBe('AllExpired');
  });

  it('reads several passes pasted together', () => {
    const two = `${text}\n${passToText(pass('2026-11', 'C'), { server: SERVER, owner: OWNER })}`;
    expect(parsePassText(two, { server: SERVER, now: NOV }).passes).toHaveLength(2);
  });
});

describe('fingerprints', () => {
  it('are short, stable hex', () => {
    expect(keyFingerprint('spki')).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint('spki')).toBe(keyFingerprint('spki'));
    expect(passId(pass('2026-11'))).toMatch(/^[0-9a-f]{12}$/);
    expect(passId(pass('2026-11'))).not.toBe(passId(pass('2026-11', 'B')));
  });
});
