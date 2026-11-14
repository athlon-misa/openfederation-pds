'use client';

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { ThemeProvider } from 'next-themes';
import {
  APPEARANCE_KEY, DEFAULT_PRESET, MODE_KEY, SERVER_DEFAULT_KEY, applyServerDefault, clearPreset, isPreset, normalizePreset,
  readPersonalPreset, readPreset, savePreset, type Preset,
} from '@/lib/appearance';
import { THIS_PDS } from '@/lib/this-pds';

const CHANGE_EVENT = 'pds-appearance-change';
interface AppearanceValue {
  preset: Preset;
  ready: boolean;
  /** The person chose this look themselves (it is not the server's default). */
  personal: boolean;
  setPreset: (value: string) => void;
  /** Forget the person's choice and follow the server's default again. */
  followServerDefault: () => void;
}
const AppearanceContext = createContext<AppearanceValue>({
  preset: DEFAULT_PRESET, ready: false, personal: false, setPreset: () => {}, followServerDefault: () => {},
});

function showStored() {
  let next: Preset = DEFAULT_PRESET;
  try { next = readPreset(window.localStorage); } catch { /* Storage may be disabled. */ }
  document.documentElement.dataset.theme = next;
}

function subscribe(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === APPEARANCE_KEY || event.key === SERVER_DEFAULT_KEY || event.key === null) {
      showStored();
      onChange();
    }
  }
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
function hasPersonalChoice(): boolean {
  try { return readPersonalPreset(window.localStorage) !== null; } catch { return false; }
}
// One string, so the snapshot stays stable between renders.
const snapshot = () => `${normalizePreset(document.documentElement.dataset.theme)}|${hasPersonalChoice() ? 1 : 0}`;
const serverSnapshot = () => null;
function setPreset(value: string) {
  const preset = normalizePreset(value);
  document.documentElement.dataset.theme = preset;
  try { savePreset(window.localStorage, preset); } catch { /* Access itself may throw. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
function followServerDefault() {
  try { clearPreset(window.localStorage); } catch { /* Access itself may throw. */ }
  showStored();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The server's default look, from its public config; undefined when it cannot be read. */
async function fetchServerDefault(): Promise<unknown> {
  const res = await fetch(`${THIS_PDS.replace(/\/+$/, '')}/xrpc/net.openfederation.server.getPublicConfig`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { appearance?: { defaultPreset?: unknown } };
  return body?.appearance?.defaultPreset;
}

/**
 * Presets with their own tab icon. The extra <link> is ours, added last so it
 * wins over the app icon; the one Next renders from metadata is never touched.
 * Follows the look in effect, whether the person chose it or it is the
 * server's default.
 */
const PRESET_ICONS: Partial<Record<Preset, string>> = { opennewsrooms: '/opennewsrooms/favicon-32.png' };
const ICON_ID = 'preset-icon';
function usePresetIcon(preset: Preset | null) {
  useEffect(() => {
    const href = preset ? PRESET_ICONS[preset] : undefined;
    let link = document.getElementById(ICON_ID) as HTMLLinkElement | null;
    if (!href) { link?.remove(); return; }
    if (!link) {
      link = document.createElement('link');
      link.id = ICON_ID; link.rel = 'icon'; link.type = 'image/png'; link.setAttribute('sizes', '32x32');
    }
    link.href = href;
    document.head.append(link);
  }, [preset]);
}

export function AppearanceProvider({ children, loadServerDefault = fetchServerDefault }: {
  children: React.ReactNode;
  /** For tests: where the server's default comes from. */
  loadServerDefault?: () => Promise<unknown>;
}) {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [preset, personal] = state ? state.split('|') : [null, '0'];
  usePresetIcon(state ? normalizePreset(preset) : null);

  // The pre-paint script used the default remembered from the last visit;
  // now that the server can be asked, follow its current one, unless the
  // person chose their own look.
  useEffect(() => {
    let cancelled = false;
    loadServerDefault().then((value) => {
      if (cancelled || value === undefined) return;
      let next: Preset | null = null;
      try { next = applyServerDefault(window.localStorage, value); } catch {
        // Storage is disabled, so no choice of the person's can have been kept.
        next = isPreset(value) ? value : null;
      }
      if (next && document.documentElement.dataset.theme !== next) {
        document.documentElement.dataset.theme = next;
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }
    }).catch(() => { /* Offline or an older server: keep the look already shown. */ });
    return () => { cancelled = true; };
  }, [loadServerDefault]);

  return (
    <ThemeProvider attribute="class" storageKey={MODE_KEY} defaultTheme="light" enableSystem disableTransitionOnChange>
      <AppearanceContext.Provider value={{
        preset: normalizePreset(preset), ready: state !== null, personal: personal === '1', setPreset, followServerDefault,
      }}>
        {children}
      </AppearanceContext.Provider>
    </ThemeProvider>
  );
}
export const useAppearance = () => useContext(AppearanceContext);
