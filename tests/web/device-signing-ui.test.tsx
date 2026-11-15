/** @vitest-environment happy-dom */
/**
 * The device-signing setting in Identity & keys (#240, phase 3): what it shows
 * for each custody mode, policy and state, and that the feature list comes
 * from the server, not from the dashboard.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DeviceSigningStatus, SwitchBack } from '../../web-interface/src/lib/custody/device-signing';
import type { AccountContext } from '../../web-interface/src/components/account/account-gate';

const state = vi.hoisted(() => ({
  status: null as DeviceSigningStatus | null,
  switchBack: null as SwitchBack | null,
  storedKey: null as string | null,
}));

vi.mock('@/lib/custody/device-signing', () => ({
  deviceSigningStatus: async () => state.status,
  findSwitchBack: async () => state.switchBack,
  loadDeviceKey: () => (state.storedKey ? { kind: 'device-repo-key', didKey: state.storedKey } : null),
  headSignedBy: async () => true,
  cancelSwitchBack: vi.fn(), replaceDevice: vi.fn(), resumeDeviceSigning: vi.fn(), turnOffDeviceSigning: vi.fn(), turnOnDeviceSigning: vi.fn(),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/account/identity', useRouter: () => ({ push: vi.fn() }) }));

const { DeviceSigningSection } = await import('../../web-interface/src/components/account/device-signing-section');

const FEATURES = [
  { id: 'repo.write', title: 'Posts written by an app that signs on your device', available: true },
  { id: 'forum', title: 'Forum threads from the server list', available: false },
];
const DEVICE = 'did:key:zQ3shDeviceKeyForTheTestsOnly1234567890abcdef';
const SERVER = 'did:key:zQ3shServerKeyForTheTestsOnly1234567890abcdef';

function status(over: Partial<DeviceSigningStatus>): DeviceSigningStatus {
  return {
    allowed: true, custodyMode: 'self', eligible: true, deviceSigning: false, since: null, recordedKey: null,
    atprotoKey: SERVER, plcReadable: true, serverKey: SERVER, state: 'off', features: FEATURES, ...over,
  };
}
function ctx(mode: AccountContext['mode']): AccountContext {
  return { did: 'did:plc:test', handle: 'alice.test', email: null, accessToken: 'jwt', mode, policy: null, refresh: async () => undefined };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  state.switchBack = null; state.storedKey = null;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function show(mode: AccountContext['mode']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><DeviceSigningSection ctx={ctx(mode)} /></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);

describe('device signing setting', () => {
  it('explains instead of offering it to a custodial account', async () => {
    state.status = status({ custodyMode: 'custodial', eligible: false });
    await show('custodial');
    expect(host.textContent).toContain('Not for Custodial accounts');
    expect(buttons()).not.toContain('Turn on device signing…');
  });

  it('says the server does not offer it when the policy is off', async () => {
    state.status = status({ allowed: false, eligible: false });
    await show('self');
    expect(host.textContent).toContain('This server does not offer device signing');
    expect(buttons()).not.toContain('Turn on device signing…');
  });

  it('offers to turn it on, with the four answers and the server\'s own feature list', async () => {
    state.status = status({});
    await show('self');
    expect(buttons()).toContain('Turn on device signing…');
    for (const label of ['What it means', 'What you are responsible for', 'What can go wrong', 'How to undo it', 'What it protects', 'What you give up', 'If you lose this device']) {
      expect(host.textContent).toContain(label);
    }
    expect(host.textContent).toContain('Forum threads from the server list');
    const items = [...host.querySelectorAll('[aria-label="Features while device signing is on"] li')].map((li) => li.textContent);
    expect(items).toEqual(['Posts written by an app that signs on your deviceWorks', 'Forum threads from the server listNot while it is on']);
    expect(host.textContent).toContain('Only your 12 words (or your backup phrase) can turn it off');
  });

  it('when on: says whether this device holds the key, and offers a new key, a takeover and turning off', async () => {
    state.status = status({ deviceSigning: true, state: 'on', atprotoKey: DEVICE, recordedKey: DEVICE });
    state.storedKey = DEVICE;
    await show('assisted');
    expect(host.textContent).toContain('This device holds the key.');
    expect(buttons()).toEqual(expect.arrayContaining(['Make a new key on this device…', 'Turn off…']));
    expect(host.textContent).toContain('This server\'s backup key could also switch it off');

    await act(async () => root.unmount());
    root = createRoot(host);
    state.storedKey = null;
    await show('assisted');
    expect(host.textContent).toContain('This device does not hold the key');
    expect(buttons()).toContain('This device takes over…');
  });

  it('shows a switch back by the server\'s backup key, with its deadline and a way to cancel', async () => {
    state.status = status({ custodyMode: 'assisted', deviceSigning: true, state: 'switchedBack', atprotoKey: SERVER });
    state.switchBack = { createdAt: new Date().toISOString(), cancelUntil: new Date(Date.now() + 70 * 3600_000), cancellable: true, signerRank: 1, toServerKey: true, before: {} as SwitchBack['before'] };
    await show('assisted');
    expect(host.textContent).toContain('this server\'s backup key switched device signing off');
    expect(buttons()).toContain('Cancel it with my 12 words…');
  });

  it('offers to turn it back on when the identity still names the device\'s key', async () => {
    state.status = status({ custodyMode: 'assisted', deviceSigning: false, state: 'resumable', atprotoKey: DEVICE });
    await show('assisted');
    expect(buttons()).toContain('Turn device signing back on');
    expect(buttons()).not.toContain('Turn on device signing…');
  });
});
