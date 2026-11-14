/** Visual presets are independent of next-themes' light/dark mode. */
export const PRESETS = [
  { id: 'pds-basic', label: 'PDS Basic', description: 'The original PDS appearance' },
  { id: 'openfederation', label: 'OpenFederation', description: 'Paper, ink, and a little teal' },
  { id: 'opennewsrooms', label: 'Open Newsrooms', description: 'Newsprint, serif type, and a red mark' },
] as const;
export type Preset = (typeof PRESETS)[number]['id'];
export const DEFAULT_PRESET: Preset = 'openfederation';
export const APPEARANCE_KEY = 'pds-appearance';
export const MODE_KEY = 'pds-color-mode';

const PRESET_IDS: readonly string[] = PRESETS.map((item) => item.id);
export function normalizePreset(value: unknown): Preset {
  return typeof value === 'string' && PRESET_IDS.includes(value) ? (value as Preset) : DEFAULT_PRESET;
}
export function readPreset(storage: Pick<Storage, 'getItem'>): Preset {
  try { return normalizePreset(storage.getItem(APPEARANCE_KEY)); }
  catch { return DEFAULT_PRESET; }
}
export function savePreset(storage: Pick<Storage, 'setItem'>, preset: Preset): void {
  try { storage.setItem(APPEARANCE_KEY, preset); } catch { /* Still applies for this page. */ }
}

// Runs synchronously before paint; only fixed, allowlisted values reach the DOM.
// The ids are this file's literals (JSON-quoted), never the stored value itself.
export const appearanceScript = `(()=>{let p=${JSON.stringify(DEFAULT_PRESET)};try{const s=localStorage.getItem('${APPEARANCE_KEY}');for(const a of ${JSON.stringify(PRESET_IDS)})if(s===a)p=a;const m=localStorage.getItem('${MODE_KEY}');if(m&&!['light','dark','system'].includes(m))localStorage.setItem('${MODE_KEY}','light')}catch{}document.documentElement.dataset.theme=p})()`;
