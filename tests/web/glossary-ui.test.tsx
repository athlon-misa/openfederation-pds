/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GlossaryLayout from '../../web-interface/src/app/glossary/layout';
import GlossaryPage from '../../web-interface/src/app/glossary/page';

const session = vi.hoisted(() => ({ isAuthenticated: true, handle: 'alice', email: 'alice@example.test', roles: [], hasAdminAccess: false, isAdmin: false }));
vi.mock('@/store/auth-store', () => ({ useAuthStore: (selector: (s: typeof session) => unknown) => selector(session) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/glossary', useRouter: () => ({ push: vi.fn() }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  session.isAuthenticated = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it('keeps the shared navigation and header around the glossary when signed in', async () => {
  await act(async () => root.render(<GlossaryLayout><GlossaryPage /></GlossaryLayout>));
  expect(host.querySelector('header')).not.toBeNull();
  expect(host.querySelector('a[href="/communities"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Search pages and actions"]')).not.toBeNull();
  expect(host.querySelectorAll('main').length).toBe(1);
  expect(host.querySelector('h1')?.textContent).toBe('Glossary');
});
it('keeps glossary definitions public without authenticated navigation', async () => {
  session.isAuthenticated = false;
  await act(async () => root.render(<GlossaryLayout><GlossaryPage /></GlossaryLayout>));
  expect(host.querySelector('h1')?.textContent).toBe('Glossary');
  expect(host.querySelector('a[href="/login"]')).not.toBeNull();
  expect(host.querySelector('a[href="/admin/users"]')).toBeNull();
});
