/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DataTable } from '../../web-interface/src/components/data-table/data-table';
import { useAdminFilters } from '../../web-interface/src/hooks/use-admin-filters';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    (notify: () => void) => { window.addEventListener('popstate', notify); return () => window.removeEventListener('popstate', notify); },
    () => window.location.search,
    () => '',
  )),
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.history.replaceState(null, '', '/admin/users?status=pending&page=3');
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('shows a retry action instead of empty results on failure and retains cached rows on refresh failure', async () => {
  const retry = vi.fn();
  const columns = [{ accessorKey: 'handle', header: 'Handle' }];
  await act(async () => root.render(<DataTable columns={columns} data={[]} hasData={false} error={new Error('Connection lost')} onRetry={retry} />));
  expect(host.textContent).toContain('Could not load data');
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => host.querySelector('button')!.click()); expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<DataTable columns={columns} data={[{ handle: 'alice' }]} hasData error={new Error('Connection lost')} onRetry={retry} />));
  expect(host.textContent).toContain('alice');
  expect(host.textContent).toContain('Showing the last available data');
});

it('labels pagination controls and disables next on the last page', async () => {
  const change = vi.fn();
  await act(async () => root.render(<DataTable columns={[{ accessorKey: 'handle', header: 'Handle' }]} data={[{ handle: 'alice' }]} page={1} total={51} pageSize={50} onPageChange={change} />));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.click());
  expect(change).toHaveBeenCalledWith(0);
  expect(host.textContent).toContain('51–51 of 51');
});

function Filters() {
  const f = useAdminFilters();
  return <><output>{`${f.status}:${f.querySearch}:${f.page}`}</output>
    <input aria-label="Search" value={f.search} onChange={(e) => f.setSearch(e.target.value)} />
    <button onClick={() => f.setSearch('alice')}>Search Alice</button>
    <button onClick={() => f.setStatus('approved')}>Approved</button>
    <button onClick={f.clear}>Clear</button>
  </>;
}
async function click(label: string) { await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click()); }

describe('URL-backed user filtering', () => {
  beforeEach(() => {
    // Emulate Next's documented integration of native history with useSearchParams.
    const replace = window.history.replaceState.bind(window.history);
    vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => { replace(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  });
  it('reads pending links, debounces search, resets page, and clears filters', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Filters />));
    expect(host.querySelector('output')?.textContent).toBe('pending::2');
    await click('Search Alice');
    await act(async () => vi.advanceTimersByTime(299));
    expect(window.location.search).not.toContain('q=alice');
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.querySelector('output')?.textContent).toBe('pending:alice:0');
    await click('Clear'); expect(window.location.search).toBe('');
    expect(host.querySelector('input')?.value).toBe('');
  });
  it('discards pending input when navigating to a different filter URL', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Filters />));
    await click('Search Alice');
    await act(async () => window.history.replaceState(null, '', '/admin/users?status=approved'));
    await act(async () => vi.advanceTimersByTime(500));
    expect(window.location.search).toBe('?status=approved');
    expect(host.querySelector('output')?.textContent).toBe('approved::0');
    expect(host.querySelector('input')?.value).toBe('');
  });
});

it('does not resurrect an abandoned search after navigating away and back', async () => {
  vi.useFakeTimers();
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => { replace(...args); window.dispatchEvent(new PopStateEvent('popstate')); });
  await act(async () => root.render(<Filters />));
  await click('Search Alice');
  await act(async () => window.history.replaceState(null, '', '/admin/users?status=approved'));
  await act(async () => window.history.replaceState(null, '', '/admin/users?status=pending&page=3'));
  await act(async () => vi.advanceTimersByTime(500));
  expect(window.location.search).not.toContain('alice');
  expect(host.querySelector('input')?.value).toBe('');
});

it('keeps empty-state guidance outside the horizontally scrolling table', async () => {
  await act(async () => root.render(<DataTable columns={[{ accessorKey: 'handle', header: 'Handle' }]} data={[]} emptyTitle="No users match these filters" emptyDescription="Clear the filters to see all users." />));
  const guidance = [...host.querySelectorAll('p')].find((p) => p.textContent === 'Clear the filters to see all users.')!;
  expect(guidance).toBeDefined();
  expect(host.querySelector('[data-slot="table-container"]')?.contains(guidance)).toBe(false);
  expect(guidance.closest('[role="status"]')?.textContent).toContain('No users match these filters');
});
