'use client';

import { useEffect, useState } from 'react';
import { rememberPhraseWithPasskey } from '@open-federation/sdk/custody';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { call } from '@/lib/move/xrpc';
import {
  MODE_TEXT, changeCustody, identityPolicy, recentIdentityChanges, cancelIdentityChange, loadRemembered, saveRemembered, forgetRemembered,
  recoverWithNewPhrase,
  type CustodyMode, type IdentityChange,
} from '@/lib/custody/custody';
import { ExistingPhrase, NewPhrase } from './phrase-inputs';
import { RecoverySection } from './recovery-section';

const THIS_PDS = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

export function CustodyCard({ did, handle, accessToken }: { did: string; handle: string; accessToken: string }) {
  const [mode, setMode] = useState<CustodyMode | null>(null);
  const [allowed, setAllowed] = useState<CustodyMode[]>([]);
  const [target, setTarget] = useState<CustodyMode | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [changes, setChanges] = useState<IdentityChange[] | null>(null);
  const [cancelling, setCancelling] = useState<IdentityChange | null>(null);
  const [offerRemember, setOfferRemember] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);
  useEffect(() => {
    let alive = true;
    (async () => {
      const level = await call<{ custodyMode?: CustodyMode | null }>(THIS_PDS, 'net.openfederation.account.getSecurityLevel', { jwt: accessToken }).catch(() => null);
      const policy = await identityPolicy(THIS_PDS);
      const current = level?.custodyMode ?? null;
      const recent = current && current !== 'custodial' ? await recentIdentityChanges(THIS_PDS, did).catch(() => []) : null;
      if (!alive) return;
      setMode(current);
      setAllowed(policy?.custodyAllowed ?? []);
      setChanges(recent);
    })();
    return () => { alive = false; };
  }, [accessToken, did, reloads]);

  if (!mode) return null; // external accounts and the local admin have no custody mode

  const reset = () => { setTarget(null); setPhrase(null); setPassword(''); setCancelling(null); setRecovering(false); };

  async function recover() {
    if (!phrase) return;
    setBusy(true); setMessage(null);
    try {
      const done = await recoverWithNewPhrase({ pdsUrl: THIS_PDS, jwt: accessToken, password, phrase });
      forgetRemembered(did);
      setMessage({ ok: true, text: `Recovered: your new phrase controls your identity. The old phrase could cancel this until ${new Date(done.cancelUntil).toLocaleString()}; if it was stolen, tell the operator.` });
      setOfferRemember(phrase);
      reset(); reload();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message.replace(/\.+$/, '') + '. Nothing was changed.' });
    } finally { setBusy(false); setPassword(''); }
  }

  async function change() {
    if (!target || !phrase || !mode) return;
    setBusy(true); setMessage(null);
    try {
      await changeCustody({ pdsUrl: THIS_PDS, jwt: accessToken, did, from: mode, to: target, password, phrase });
      setMessage({ ok: true, text: `Done: your account is now ${MODE_TEXT[target].title.toLowerCase()}.` });
      if (target !== 'custodial' && !loadRemembered(did)) setOfferRemember(phrase);
      if (target === 'custodial') forgetRemembered(did);
      reset(); reload();
    } catch (e) {
      const reason = (e as Error).message.replace(/\.+$/, '');
      setMessage({ ok: false, text: `${reason}. Nothing was changed unless the message says otherwise.` });
      // An existing phrase may simply be mistyped: ask for it again. A new one was written down: keep it.
      if (mode !== 'custodial') setPhrase(null);
    } finally { setBusy(false); setPassword(''); }
  }

  async function cancel(phraseText: string) {
    if (!cancelling) return;
    setBusy(true); setMessage(null);
    try {
      await cancelIdentityChange({ pdsUrl: THIS_PDS, did, phrase: phraseText, change: cancelling });
      setMessage({ ok: true, text: 'The change is cancelled. Change your password if you did not make it.' });
      reset(); reload();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  }

  const targets = allowed.filter((m) => m !== mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Identity custody: {MODE_TEXT[mode].title}</CardTitle>
        <CardDescription>{MODE_TEXT[mode].what}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!target && !cancelling && !recovering && !recoveryOpen && targets.length > 0 && (
          <div className="space-y-2">
            {targets.map((m) => (
              <div key={m} className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div className="text-sm"><span className="font-medium">{MODE_TEXT[m].title}</span><span className="block text-muted-foreground">{MODE_TEXT[m].what}</span></div>
                <Button type="button" variant="outline" onClick={() => { setMessage(null); setTarget(m); }}>Switch</Button>
              </div>
            ))}
          </div>
        )}

        {mode === 'assisted' && !target && !cancelling && !recovering && !recoveryOpen && (
          <Button type="button" variant="ghost" className="px-0" onClick={() => { setMessage(null); setRecovering(true); }}>Lost your phrase?</Button>
        )}

        {recovering && (
          <div className="space-y-4 rounded-md border p-4">
            <p className="text-sm font-medium">Recover with a new phrase</p>
            <p className="text-sm text-muted-foreground">First ask this server&apos;s operator to verify your identity: they send you a code by email, and you read it back to them. Within 30 minutes of that, continue here. Your old phrase keeps the power to cancel this for 72 hours, so a recovery someone else starts fails while you still have it.</p>
            {!phrase && <NewPhrase onReady={setPhrase} />}
            {phrase && (
              <div className="space-y-2">
                <Label htmlFor="recover-password">Your password</Label>
                <Input id="recover-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="flex gap-2">
                  <Button type="button" onClick={recover} disabled={!password || busy}>{busy ? 'Recovering…' : 'Recover'}</Button>
                  <Button type="button" variant="outline" onClick={reset} disabled={busy}>Cancel</Button>
                </div>
              </div>
            )}
            {!phrase && <Button type="button" variant="ghost" onClick={reset}>Back</Button>}
          </div>
        )}

        {target && (
          <div className="space-y-4 rounded-md border p-4">
            <p className="text-sm font-medium">Switch to {MODE_TEXT[target].title.toLowerCase()}</p>
            {!phrase && (mode === 'custodial' ? <NewPhrase onReady={setPhrase} /> : <ExistingPhrase did={did} onReady={setPhrase} />)}
            {phrase && (
              <div className="space-y-2">
                <Label htmlFor="custody-password">Your password</Label>
                <Input id="custody-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="flex gap-2">
                  <Button type="button" onClick={change} disabled={!password || busy}>{busy ? 'Switching…' : `Switch to ${MODE_TEXT[target].title.toLowerCase()}`}</Button>
                  <Button type="button" variant="outline" onClick={reset} disabled={busy}>Cancel</Button>
                </div>
              </div>
            )}
            {!phrase && <Button type="button" variant="ghost" onClick={reset}>Back</Button>}
          </div>
        )}

        {offerRemember && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>Unlock your phrase on this device with a passkey (Face ID, Touch ID, Windows Hello) instead of typing it each time? Your paper copy stays the backup.</p>
            <div className="flex gap-2">
              <Button type="button" onClick={async () => {
                try {
                  saveRemembered(did, await rememberPhraseWithPasskey({ phrase: offerRemember, rpName: 'OpenFederation', userName: handle }));
                  setMessage({ ok: true, text: 'This device will unlock your phrase with its passkey.' });
                } catch { setMessage({ ok: false, text: 'This browser or device cannot do it; keep using your phrase.' }); }
                setOfferRemember(null);
              }}>Use a passkey on this device</Button>
              <Button type="button" variant="outline" onClick={() => setOfferRemember(null)}>Not now</Button>
            </div>
          </div>
        )}

        {changes && changes.length > 0 && !target && !recoveryOpen && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Changes to your identity in the last 72 hours</p>
            {changes.map((c) => (
              <div key={c.cid} className="flex items-start justify-between gap-4 rounded-md border p-3 text-sm">
                <div>
                  <span>{new Date(c.createdAt).toLocaleString()}: {c.summary.join(', ')}{c.signedByLowerKey ? ' — not signed with your phrase (this server\'s backup key or your recovery key)' : ''}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{c.cid}</span>
                </div>
                {c.cancellable && <Button type="button" variant="outline" onClick={() => { setMessage(null); setCancelling(c); }}>Cancel this change</Button>}
              </div>
            ))}
            {cancelling && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm">Cancelling restores your identity to how it was before this change. Enter the phrase you had then.</p>
                <ExistingPhrase did={did} onReady={cancel} />
                <Button type="button" variant="ghost" onClick={() => setCancelling(null)} disabled={busy}>Back</Button>
              </div>
            )}
          </div>
        )}

        {message && <p className={`text-sm ${message.ok ? 'text-green-700' : 'text-destructive'}`} role="status">{message.text}</p>}

        {mode !== 'custodial' && !target && !cancelling && !recovering && (
          <RecoverySection did={did} mode={mode} onActive={setRecoveryOpen} onChanged={reload}
            onRecovered={(newPhrase) => { forgetRemembered(did); setOfferRemember(newPhrase); }} />
        )}
      </CardContent>
    </Card>
  );
}
