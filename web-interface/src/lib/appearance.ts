/** Visual presets are independent of next-themes' light/dark mode. */
export const PRESETS = [
  { id: 'pds-basic', label: 'PDS Basic', description: 'The original PDS appearance' },
  { id: 'openfederation', label: 'OpenFederation', description: 'Paper, ink, and a little teal' },
  { id: 'opennewsrooms', label: 'Open Newsrooms', description: 'Newsprint, serif type, and a red mark' },
] as const;
export type Preset = (typeof PRESETS)[number]['id'];
export const DEFAULT_PRESET: Preset = 'openfederation';
/** The person's own choice. When it is absent, the server's default applies. */
export const APPEARANCE_KEY = 'pds-appearance';
/**
 * The server's default (getPublicConfig.appearance.defaultPreset), remembered
 * from the last visit so the first paint can use it before the config loads.
 */
export const SERVER_DEFAULT_KEY = 'pds-appearance-server-default';
export const MODE_KEY = 'pds-color-mode';

const PRESET_IDS: readonly string[] = PRESETS.map((item) => item.id);

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && PRESET_IDS.includes(value);
}
export function normalizePreset(value: unknown): Preset {
  return isPreset(value) ? value : DEFAULT_PRESET;
}

/**
 * Which look to show: the person's own choice always wins, then the server's
 * default, then the built-in one. Anything this dashboard does not have (a
 * preset added on the server first, or a tampered value) is ignored.
 */
export function choosePreset(choice: { personal: unknown; serverDefault: unknown }): Preset {
  if (isPreset(choice.personal)) return choice.personal;
  if (isPreset(choice.serverDefault)) return choice.serverDefault;
  return DEFAULT_PRESET;
}

function read(storage: Pick<Storage, 'getItem'>, key: string): Preset | null {
  try {
    const value = storage.getItem(key);
    return isPreset(value) ? value : null;
  } catch {
    return null;
  }
}
export function readPersonalPreset(storage: Pick<Storage, 'getItem'>): Preset | null {
  return read(storage, APPEARANCE_KEY);
}
export function readServerDefault(storage: Pick<Storage, 'getItem'>): Preset | null {
  return read(storage, SERVER_DEFAULT_KEY);
}
/** The look in effect for this browser. */
export function readPreset(storage: Pick<Storage, 'getItem'>): Preset {
  return choosePreset({ personal: readPersonalPreset(storage), serverDefault: readServerDefault(storage) });
}
export function savePreset(storage: Pick<Storage, 'setItem'>, preset: Preset): void {
  try { storage.setItem(APPEARANCE_KEY, preset); } catch { /* Still applies for this page. */ }
}
/** Forget the person's own choice, so the server's default applies again. */
export function clearPreset(storage: Pick<Storage, 'removeItem'>): void {
  try { storage.removeItem(APPEARANCE_KEY); } catch { /* Storage may be disabled. */ }
}
/**
 * Remember the server's default for the next first paint. A value this
 * dashboard does not have forgets the remembered one. Returns what was kept.
 */
export function saveServerDefault(storage: Pick<Storage, 'setItem' | 'removeItem'>, value: unknown): Preset | null {
  try {
    if (isPreset(value)) storage.setItem(SERVER_DEFAULT_KEY, value);
    else storage.removeItem(SERVER_DEFAULT_KEY);
  } catch { /* Storage may be disabled. */ }
  return isPreset(value) ? value : null;
}
/**
 * The server's default has arrived: remember it, and return the look to show
 * now (unchanged when the person has chosen their own).
 */
export function applyServerDefault(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, value: unknown): Preset {
  const serverDefault = saveServerDefault(storage, value);
  return choosePreset({ personal: readPersonalPreset(storage), serverDefault });
}

// Runs synchronously before paint, and cannot fetch: the person's choice,
// else the server default remembered from the last visit, else the built-in
// one. The ids are this file's literals (JSON-quoted), never a stored value.
export const appearanceScript = `(()=>{const i=${JSON.stringify(PRESET_IDS)};let p=${JSON.stringify(DEFAULT_PRESET)};try{const s=localStorage.getItem('${APPEARANCE_KEY}'),d=localStorage.getItem('${SERVER_DEFAULT_KEY}');let f=0;for(const a of i)if(s===a){p=a;f=1}if(!f)for(const a of i)if(d===a)p=a;const m=localStorage.getItem('${MODE_KEY}');if(m&&!['light','dark','system'].includes(m))localStorage.setItem('${MODE_KEY}','light')}catch{}document.documentElement.dataset.theme=p})()`;
