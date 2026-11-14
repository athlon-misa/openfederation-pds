/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKBar } from 'kbar';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandPaletteProvider } from '../../web-interface/src/providers/command-palette-provider';
vi.mock('@/store/auth-store', () => ({ useAuthStore: (selector: (s: { isAdmin: boolean }) => unknown) => selector({ isAdmin: true }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
let root: Root;
let host: HTMLDivElement;
function OpenSearch() { const { query } = useKBar(); return <button onClick={query.toggle}>Search</button>; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('has one results scroll area without a nested scrolling wrapper', async () => {
  await act(async () => root.render(<CommandPaletteProvider><OpenSearch /></CommandPaletteProvider>));
  await act(async () => { host.querySelector('button')!.click(); await new Promise((r) => setTimeout(r, 150)); });
  const list = document.querySelector('[role="listbox"]');
  expect(list).not.toBeNull();
  expect((list!.parentElement as HTMLElement).style.overflow).toBe('auto');
  let ancestor = list!.parentElement!.parentElement;
  while (ancestor && ancestor !== document.body) {
    expect(ancestor.className).not.toMatch(/overflow-(?:y-)?auto|overflow-(?:y-)?scroll/);
    ancestor = ancestor.parentElement;
  }
});

it('bounds results height to a short viewport', async () => {
  const original = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 });
  try {
    await act(async () => root.render(<CommandPaletteProvider><OpenSearch /></CommandPaletteProvider>));
    await act(async () => { host.querySelector('button')!.click(); await new Promise((r) => setTimeout(r, 150)); });
    const scroll = document.querySelector('[role="listbox"]')!.parentElement as HTMLElement;
    expect(parseFloat(scroll.style.maxHeight)).toBeLessThan(240);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(parseFloat(scroll.style.maxHeight)).toBeLessThan(120);
  } finally { Object.defineProperty(window, 'innerHeight', { configurable: true, value: original }); }
});
