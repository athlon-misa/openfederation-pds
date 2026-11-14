/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTheme } from 'next-themes';
import { AppearanceProvider, useAppearance } from '../../web-interface/src/providers/appearance-provider';
import { AppearanceMenu } from '../../web-interface/src/components/appearance-menu';
import { APPEARANCE_KEY, MODE_KEY } from '../../web-interface/src/lib/appearance';

let root: Root;
let host: HTMLDivElement;
function Controls() {
  const { preset, setPreset } = useAppearance();
  const { theme, setTheme } = useTheme();
  return <>
    <output>{preset}:{theme}</output>
    <button onClick={() => setPreset('pds-basic')}>Basic</button>
    <button onClick={() => setTheme('dark')}>Dark</button>
    <AppearanceMenu />
  </>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  document.documentElement.dataset.theme = 'openfederation';
  document.documentElement.className = '';
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function render() { await act(async () => root.render(<AppearanceProvider><Controls /></AppearanceProvider>)); }
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
  await act(async () => button.click());
}

describe('appearance integration', () => {
  it('changes and persists presets independently of dark mode, including across remounts', async () => {
    await render();
    await click('Dark'); await click('Basic');
    expect(document.documentElement.dataset.theme).toBe('pds-basic');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe('pds-basic');
    expect(localStorage.getItem(MODE_KEY)).toBe('dark');
    await act(async () => root.unmount()); root = createRoot(host); await render();
    expect(host.querySelector('output')?.textContent).toBe('pds-basic:dark');
  });
  it('syncs preset changes from another tab without disturbing mode', async () => {
    await render(); await click('Dark');
    localStorage.setItem(APPEARANCE_KEY, 'pds-basic');
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: 'pds-basic' })));
    expect(host.querySelector('output')?.textContent).toBe('pds-basic:dark');
    localStorage.removeItem(APPEARANCE_KEY);
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: null })));
    expect(document.documentElement.dataset.theme).toBe('openfederation');
  });
  it('opens an accessible portalled menu containing every named theme and all color modes', async () => {
    await render();
    const trigger = host.querySelector('[aria-label="Appearance: choose theme and color mode"]')!;
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })));
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(false);
    expect(menu?.textContent).toContain('PDS Basic');
    expect(menu?.textContent).toContain('OpenFederation');
    expect(menu?.textContent).toContain('Open Newsrooms');
    expect(menu?.querySelectorAll('[role="menuitemradio"]').length).toBe(6);
    expect(menu?.querySelector('[data-state="checked"]')?.textContent).toContain('OpenFederation');
    const basic = [...menu!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('PDS Basic'))!;
    await act(async () => basic.click());
    expect(document.documentElement.dataset.theme).toBe('pds-basic');
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe('pds-basic');
  });
  it('swaps in the Open Newsrooms tab icon only while that preset is active', async () => {
    await render();
    const icon = () => document.head.querySelector<HTMLLinkElement>('link#preset-icon');
    expect(icon()).toBeNull();
    localStorage.setItem(APPEARANCE_KEY, 'opennewsrooms');
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY, newValue: 'opennewsrooms' })));
    expect(document.documentElement.dataset.theme).toBe('opennewsrooms');
    expect(icon()?.getAttribute('href')).toBe('/opennewsrooms/favicon-32.png');
    expect(document.head.lastElementChild).toBe(icon());
    await click('Basic');
    expect(icon()).toBeNull();
  });
});
