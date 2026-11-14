/** Visual presets are independent of next-themes' light/dark mode. */
export const PRESETS = [
  { id: 'pds-basic', label: 'PDS Basic', description: 'The original PDS appearance' },
  { id: 'openfederation', label: 'OpenFederation', description: 'Paper, ink, and a little teal' },
] as const;
export type Preset = (typeof PRESETS)[number]['id'];
export const DEFAULT_PRESET: Preset = 'openfederation';
export const APPEARANCE_KEY = 'pds-appearance';
export const MODE_KEY = 'pds-color-mode';

export function normalizePreset(value: unknown): Preset {
  return value === 'pds-basic' ? value : DEFAULT_PRESET;
}
export function readPreset(storage: Pick<Storage, 'getItem'>): Preset {
  try { return normalizePreset(storage.getItem(APPEARANCE_KEY)); }
  catch { return DEFAULT_PRESET; }
}
export function savePreset(storage: Pick<Storage, 'setItem'>, preset: Preset): void {
  try { storage.setItem(APPEARANCE_KEY, preset); } catch { /* Still applies for this page. */ }
}

// Runs synchronously before paint; only fixed, allowlisted values reach the DOM.
export const appearanceScript = `(()=>{let p='openfederation';try{if(localStorage.getItem('${APPEARANCE_KEY}')==='pds-basic')p='pds-basic';const m=localStorage.getItem('${MODE_KEY}');if(m&&!['light','dark','system'].includes(m))localStorage.setItem('${MODE_KEY}','light')}catch{}document.documentElement.dataset.theme=p})()`;
