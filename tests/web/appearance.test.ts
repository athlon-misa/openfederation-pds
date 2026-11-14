import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  APPEARANCE_KEY, PRESETS, SERVER_DEFAULT_KEY, appearanceScript, normalizePreset, applyServerDefault, choosePreset, clearPreset, readPersonalPreset, readPreset,
  saveServerDefault, savePreset,
} from '../../web-interface/src/lib/appearance';

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

describe('the server\'s default appearance', () => {
  const store = (values: Record<string, string>) => ({
    getItem: (k: string) => (k in values ? values[k] : null),
    setItem: (k: string, v: string) => { values[k] = v; },
    removeItem: (k: string) => { delete values[k]; },
  });

  it('a personal choice always wins; then the server default; then the built-in one', () => {
    expect(choosePreset({ personal: 'pds-basic', serverDefault: 'openfederation' })).toBe('pds-basic');
    expect(choosePreset({ personal: null, serverDefault: 'pds-basic' })).toBe('pds-basic');
    expect(choosePreset({ personal: null, serverDefault: null })).toBe('openfederation');
    // Anything this dashboard does not know is ignored.
    expect(choosePreset({ personal: 'neon', serverDefault: 'pds-basic' })).toBe('pds-basic');
    expect(choosePreset({ personal: null, serverDefault: '<script>' })).toBe('openfederation');
    expect(choosePreset({ personal: null, serverDefault: 'opennewsrooms' })).toBe('opennewsrooms');
    expect(choosePreset({ personal: null, serverDefault: '__proto__' })).toBe('openfederation');
  });

  it('remembers the last server default, allowlisted, under its own key', () => {
    const values: Record<string, string> = {};
    const s = store(values);
    expect(saveServerDefault(s, 'pds-basic')).toBe('pds-basic');
    expect(values).toEqual({ [SERVER_DEFAULT_KEY]: 'pds-basic' });
    expect(readPreset(s)).toBe('pds-basic');
    expect(readPersonalPreset(s)).toBeNull();
    // A value this dashboard does not know forgets the old one.
    expect(saveServerDefault(s, 'neon')).toBeNull();
    expect(values).toEqual({});
    expect(() => saveServerDefault({ setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } }, 'pds-basic')).not.toThrow();
  });

  it('applyServerDefault changes the page only when the person has not chosen', () => {
    const mine = store({ [APPEARANCE_KEY]: 'openfederation' });
    expect(applyServerDefault(mine, 'pds-basic')).toBe('openfederation');
    const nobody = store({});
    expect(applyServerDefault(nobody, 'pds-basic')).toBe('pds-basic');
    expect(applyServerDefault(nobody, undefined)).toBe('openfederation');
  });

  it('clearing a personal choice falls back to the server default', () => {
    const values: Record<string, string> = { [APPEARANCE_KEY]: 'openfederation', [SERVER_DEFAULT_KEY]: 'pds-basic' };
    clearPreset(store(values));
    expect(values).toEqual({ [SERVER_DEFAULT_KEY]: 'pds-basic' });
    expect(readPreset(store(values))).toBe('pds-basic');
  });

  it('the pre-paint script uses the remembered server default when nothing is chosen, allowlisted', () => {
    const paint = (values: Record<string, string>) => {
      const root = { dataset: {} as Record<string, string> };
      runInNewContext(appearanceScript, { document: { documentElement: root }, localStorage: store(values) });
      return root.dataset.theme;
    };
    expect(paint({ [SERVER_DEFAULT_KEY]: 'pds-basic' })).toBe('pds-basic');
    expect(paint({ [SERVER_DEFAULT_KEY]: 'pds-basic', [APPEARANCE_KEY]: 'openfederation' })).toBe('openfederation');
    expect(paint({ [SERVER_DEFAULT_KEY]: '"><script>' })).toBe('openfederation');
    expect(paint({ [SERVER_DEFAULT_KEY]: 'opennewsrooms' })).toBe('opennewsrooms');
    expect(paint({ [SERVER_DEFAULT_KEY]: 'constructor' })).toBe('openfederation');
    expect(paint({ [SERVER_DEFAULT_KEY]: 'pds-basic', [APPEARANCE_KEY]: 'bogus' })).toBe('pds-basic');
  });
});
