import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { APPEARANCE_KEY, PRESETS, appearanceScript, normalizePreset, readPreset, savePreset } from '../../web-interface/src/lib/appearance';

describe('appearance preferences', () => {
  it('restores PDS Basic and defaults unknown preferences to OpenFederation', () => {
    expect(readPreset({ getItem: () => 'pds-basic' })).toBe('pds-basic');
    for (const stored of [null, '', 'unknown', '<script>']) {
      expect(readPreset({ getItem: () => stored })).toBe('openfederation');
    }
  });
  it('accepts exactly the listed preset ids, including Open Newsrooms', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['pds-basic', 'openfederation', 'opennewsrooms']);
    for (const { id } of PRESETS) expect(normalizePreset(id)).toBe(id);
    for (const value of ['OpenNewsrooms', ' opennewsrooms', 'opennewsrooms"', 'toString', '__proto__', 42, undefined, {}]) {
      expect(normalizePreset(value)).toBe('openfederation');
    }
  });
  it('continues working when storage is unavailable', () => {
    expect(readPreset({ getItem: () => { throw new Error('denied'); } })).toBe('openfederation');
    expect(() => savePreset({ setItem: () => { throw new Error('denied'); } }, 'pds-basic')).not.toThrow();
  });
  it('saves the preset separately from mode and authentication', () => {
    const writes: [string, string][] = [];
    savePreset({ setItem: (k, v) => writes.push([k, v]) }, 'pds-basic');
    expect(writes).toEqual([[APPEARANCE_KEY, 'pds-basic']]);
  });
  it('sets the root preset before hydration without changing dark mode', () => {
    const listed = ['pds-basic', 'openfederation', 'opennewsrooms'];
    for (const stored of [...listed, 'invalid', 'opennewsrooms ', '"];alert(1);//', 'constructor', null]) {
      const root = { dataset: {} as Record<string, string>, className: 'dark' };
      runInNewContext(appearanceScript, { document: { documentElement: root }, localStorage: { getItem: () => stored } });
      expect(root.dataset.theme).toBe(stored !== null && listed.includes(stored) ? stored : 'openfederation');
      expect(root.className).toBe('dark');
    }
  });
  it('uses the default on first paint when storage access throws', () => {
    const root = { dataset: {} as Record<string, string> };
    runInNewContext(appearanceScript, { document: { documentElement: root }, localStorage: { getItem: () => { throw new Error('denied'); } } });
    expect(root.dataset.theme).toBe('openfederation');
  });
});
