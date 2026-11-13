'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rememberPhraseWithPasskey } from '@open-federation/sdk/custody';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { ExistingPhrase } from '@/components/custody/phrase-inputs';
import { listSessions, revokeSession } from '@/lib/api/account';
import { assertPhraseBelongs, forgetRemembered, loadRemembered, saveRemembered } from '@/lib/custody/custody';
import { THIS_PDS } from '@/hooks/use-identity';
import { DEVICE_SIGNING, PASSKEY } from '@/lib/copy/glossary';
import { useAuthStore } from '@/store/auth-store';

export default function DevicesPage() {
  const status = useAuthStore((s) => s.status);
  return (
    <div className="space-y-6">
      <PageHeader title="Devices & passkeys" description="Where you are signed in, and whether this device unlocks your 12 words with a passkey." />
      <SignedInDevices />
      {status === 'approved' && <AccountGate>{(ctx) => <ThisDevice ctx={ctx} />}</AccountGate>}
      <Section title={DEVICE_SIGNING.title} description={<><Badge variant="outline">Coming later</Badge> {DEVICE_SIGNING.summary}</>}>
        <ChoiceExplainer text={DEVICE_SIGNING} extra={[{ label: 'Who can use it', text: DEVICE_SIGNING.availability }]} />
      </Section>
    </div>
  );
}

function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : 'not recorded';
}

function SignedInDevices() {
  const router = useRouter();
  const client = useQueryClient();
  const refresh = useAuthStore((s) => s.refresh);
  const logout = useAuthStore((s) => s.logout);
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      const res = await listSessions();
      if (!res.ok) throw new Error(res.message);
      return res.data.sessions;
    },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  async function signOut(id: string) {
    setBusy(id); setMessage(null);
    const res = await revokeSession({ sessionId: id });
    if (!res.ok) { setMessage({ ok: false, text: res.message }); setBusy(null); return; }
    // Signing a device out invalidates every access token; this browser renews
    // its own, unless it was the one signed out.
    if (await refresh()) {
      setMessage({ ok: true, text: 'That device is signed out. It needs your password to sign in again.' });
      await client.invalidateQueries({ queryKey: ['sessions'] });
      setBusy(null);
    } else {
      await logout();
      router.push('/login');
    }
  }

  async function signOutEverywhere() {
    setBusy('all'); setMessage(null);
    const res = await revokeSession({ revokeAll: true });
    if (!res.ok) { setMessage({ ok: false, text: res.message }); setBusy(null); return; }
    await logout();
    router.push('/login');
  }

  return (
    <Section
      title="Signed-in devices"
      description={<>Every browser or app where someone signed in with your password. Signing a device out does not change your identity or your 12 words. <WhatIsThis term="signed-in-device" className="mt-1" /></>}
    >
      {sessions.isLoading && <Skeleton className="h-20 rounded-md" />}
      {sessions.isError && <StatusMessage ok={false} text={`Could not load your devices: ${(sessions.error as Error).message}`} />}
      {sessions.data && (
        <ul className="divide-y rounded-md border">
          {sessions.data.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">Signed in {when(s.createdAt)}</p>
                <p className="text-muted-foreground">Last active {when(s.lastUsedAt)} · expires {when(s.expiresAt)} · <span className="font-mono text-xs">{s.id}</span></p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={!!busy} onClick={() => signOut(s.id)}>
                {busy === s.id ? 'Signing out…' : 'Sign out this device'}
              </Button>
            </li>
          ))}
          {sessions.data.length === 0 && <li className="p-3 text-sm text-muted-foreground">No signed-in devices.</li>}
        </ul>
      )}
      {message && <StatusMessage ok={message.ok} text={message.text} />}
      <Note>This server does not record which browser or app each sign-in is; the times are the way to tell them apart. If you sign out the one you are using, you go back to the sign-in page.</Note>
      <div className="space-y-3">
        <Acknowledge id="signout-all-ack" text="Sign me out everywhere, including this browser and apps I allowed to use my account." checked={confirmAll} onChange={setConfirmAll} disabled={!!busy} />
        <Button type="button" variant="destructive" disabled={!confirmAll || !!busy} onClick={signOutEverywhere}>
          {busy === 'all' ? 'Signing out…' : 'Sign out everywhere'}
        </Button>
        <p className="text-xs text-muted-foreground">Do this if you think someone else knows your password, then change it in Your account. You will be emailed that it happened.</p>
      </div>
    </Section>
  );
}

function ThisDevice({ ctx }: { ctx: AccountContext }) {
  const { did, handle, mode } = ctx;
  const [saved, setSaved] = useState(() => !!loadRemembered(did));
  const [step, setStep] = useState<'idle' | 'words' | 'forget'>('idle');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (mode === 'custodial') {
    return (
      <Section title={PASSKEY.title}>
        <Note>Your account is Custodial, so you have no 12 words to unlock. Passkeys for your 12 words are for Assisted and Self accounts.</Note>
      </Section>
    );
  }

  async function remember(phrase: string) {
    setBusy(true); setMessage(null);
    try {
      await assertPhraseBelongs(THIS_PDS, did, phrase);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      setBusy(false);
      return;
    }
    try {
      saveRemembered(did, await rememberPhraseWithPasskey({ phrase, rpName: 'OpenFederation', userName: handle }));
      setSaved(true); setStep('idle');
      setMessage({ ok: true, text: 'This device will unlock your 12 words with its passkey. Keep your paper copy.' });
    } catch {
      setMessage({ ok: false, text: 'This browser or device cannot do it (it needs a passkey that supports unlocking data). Keep typing your 12 words.' });
    } finally { setBusy(false); }
  }

  return (
    <Section
      title={PASSKEY.title}
      description={<>{PASSKEY.summary} <WhatIsThis term="passkey" className="mt-1" /></>}
    >
      <p className="text-sm font-medium">
        {saved ? 'On: this device unlocks your 12 words with a passkey.' : 'Off: on this device you type your 12 words when they are needed.'}
      </p>
      <ChoiceExplainer text={PASSKEY} />
      {step === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {!saved && <Button type="button" onClick={() => { setMessage(null); setStep('words'); }}>Use a passkey on this device…</Button>}
          {saved && <Button type="button" variant="outline" onClick={() => { setMessage(null); setStep('forget'); }}>Forget on this device…</Button>}
        </div>
      )}
      {step === 'words' && (
        <div className="space-y-3 rounded-md border p-4">
          <h3 className="text-sm font-semibold">Type your 12 words once</h3>
          <p className="text-sm text-muted-foreground">They are checked against your identity, then locked with the passkey you choose. They never leave this device.</p>
          {busy ? <p className="text-sm text-muted-foreground">Waiting for the passkey…</p> : <ExistingPhrase did={did} onReady={remember} />}
          <Button type="button" variant="ghost" onClick={() => setStep('idle')} disabled={busy}>Cancel</Button>
        </div>
      )}
      {step === 'forget' && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm">This browser deletes its locked copy of your 12 words. Your 12 words keep working; you will type them here when they are needed.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => { forgetRemembered(did); setSaved(false); setStep('idle'); setMessage({ ok: true, text: 'Forgotten on this device.' }); }}>Forget on this device</Button>
            <Button type="button" variant="ghost" onClick={() => setStep('idle')}>Keep it</Button>
          </div>
        </div>
      )}
      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </Section>
  );
}
