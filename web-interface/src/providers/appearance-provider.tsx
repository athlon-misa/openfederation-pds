'use client';

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { ThemeProvider } from 'next-themes';
import { APPEARANCE_KEY, DEFAULT_PRESET, MODE_KEY, normalizePreset, readPreset, savePreset, type Preset } from '@/lib/appearance';

const CHANGE_EVENT = 'pds-appearance-change';
const AppearanceContext = createContext<{ preset: Preset; ready: boolean; setPreset: (value: string) => void }>({
  preset: DEFAULT_PRESET, ready: false, setPreset: () => {},
});

function subscribe(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === APPEARANCE_KEY || event.key === null) {
      let next: Preset = DEFAULT_PRESET;
      try { next = readPreset(window.localStorage); } catch { /* Storage may be disabled. */ }
      document.documentElement.dataset.theme = next;
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
const snapshot = () => normalizePreset(document.documentElement.dataset.theme);
const serverSnapshot = () => null;
function setPreset(value: string) {
  const preset = normalizePreset(value);
  document.documentElement.dataset.theme = preset;
  try { savePreset(window.localStorage, preset); } catch { /* Access itself may throw. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Presets with their own tab icon. The extra <link> is ours, added last so it
 * wins over the app icon; the one Next renders from metadata is never touched.
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

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const preset = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  usePresetIcon(preset);
  return (
    <ThemeProvider attribute="class" storageKey={MODE_KEY} defaultTheme="light" enableSystem disableTransitionOnChange>
      <AppearanceContext.Provider value={{ preset: preset ?? DEFAULT_PRESET, ready: preset !== null, setPreset }}>
        {children}
      </AppearanceContext.Provider>
    </ThemeProvider>
  );
}
export const useAppearance = () => useContext(AppearanceContext);
