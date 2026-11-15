/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DemoBanner } from '../../web-interface/src/components/demo-banner';
import { demoBannerText, readDemoInfo } from '../../web-interface/src/lib/demo';

describe('the demo flag', () => {
  it('is read only when the server says it is a demo', () => {
    expect(readDemoInfo({})).toBeNull();
    expect(readDemoInfo({ demo: { enabled: false } })).toBeNull();
    expect(readDemoInfo(null)).toBeNull();
    expect(readDemoInfo({ demo: { enabled: true, nextResetAt: '2026-11-16T03:00:00.000Z', resetSchedule: '0 3 * * *' } }))
      .toEqual({ enabled: true, nextResetAt: '2026-11-16T03:00:00.000Z', resetSchedule: '0 3 * * *' });
  });

  it('says when, in UTC', () => {
    expect(demoBannerText({ enabled: true, nextResetAt: '2026-11-16T03:00:00.000Z' })).toBe('Demo server — everything is deleted every night at 03:00 UTC.');
    expect(demoBannerText({ enabled: true, nextResetAt: '2026-11-16T23:30:00.000Z' })).toBe('Demo server — everything is deleted every night at 23:30 UTC.');
    expect(demoBannerText({ enabled: true })).toMatch(/^Demo server/);
  });
});

describe('the banner', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('shows on a demo server', async () => {
    const load = async () => ({ enabled: true, nextResetAt: '2026-11-16T03:00:00.000Z' });
    await act(async () => root.render(<DemoBanner loadDemoInfo={load} />));
    const banner = host.querySelector('[role="status"]');
    expect(banner?.textContent).toBe('Demo server — everything is deleted every night at 03:00 UTC.');
  });

  it('shows nothing anywhere else, nor when the server cannot be asked', async () => {
    await act(async () => root.render(<DemoBanner loadDemoInfo={async () => null} />));
    expect(host.innerHTML).toBe('');
    await act(async () => root.render(<DemoBanner loadDemoInfo={() => Promise.reject(new Error('offline'))} />));
    expect(host.innerHTML).toBe('');
  });
});
