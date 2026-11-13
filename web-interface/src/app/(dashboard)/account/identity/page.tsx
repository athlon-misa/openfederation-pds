'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { PasskeyOffer } from '@/components/account/passkey-offer';
import { ExistingPhrase, NewPhrase } from '@/components/custody/phrase-inputs';
import { changeCustody, forgetRemembered, loadRemembered, recoverWithNewPhrase, type CustodyMode } from '@/lib/custody/custody';
import { CUSTODY, DEVICE_SIGNING, POSTING_KEY_NOTE, switchAck, switchNote } from '@/lib/copy/glossary';
import { THIS_PDS } from '@/hooks/use-identity';

const ORDER: CustodyMode[] = ['custodial', 'assisted', 'self'];

export default function IdentityPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Identity & keys" description="Who controls your identity, and what that means for you." />
      <AccountGate>{(ctx) => <IdentityScreens ctx={ctx} />}</AccountGate>
    </div>
  );
}

type Flow =
  | { kind: 'idle' }
  | { kind: 'switch'; to: CustodyMode; step: 'understand' | 'words' | 'password'; ack: boolean; phrase: string | null }
  | { kind: 'recover'; step: 'understand' | 'words' | 'password'; ack: boolean; phrase: string | null };

function Steps({ current, labels }: { current: number; labels: string[] }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Steps">
      {labels.map((l, i) => (
        <li key={l} aria-current={i === current ? 'step' : undefined} className={i === current ? 'font-semibold text-foreground' : ''}>
          {i + 1}. {l}{i < current ? ' (done)' : ''}
        </li>
      ))}
    </ol>
  );
}

function IdentityScreens({ ctx }: { ctx: AccountContext }) {
  const { did, handle, accessToken, mode, policy } = ctx;
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; next?: 'recovery' | 'history' } | null>(null);
  const [offerRemember, setOfferRemember] = useState<string | null>(null);

  const allowed = policy?.custodyAllowed ?? [];
  const others = ORDER.filter((m) => m !== mode && allowed.includes(m));
  const close = () => { setFlow({ kind: 'idle' }); setPassword(''); };

  async function doSwitch(to: CustodyMode, phrase: string) {
    setBusy(true); setMessage(null);
    try {
      await changeCustody({ pdsUrl: THIS_PDS, jwt: accessToken, did, from: mode, to, password, phrase });
      if (to !== 'custodial' && !loadRemembered(did)) setOfferRemember(phrase);
      if (to === 'custodial') forgetRemembered(did);
      setMessage({
        ok: true,
        text: to === 'custodial'
          ? 'Done: this server now controls your identity. Your 12 words no longer do anything; you can destroy the paper.'
          : `Done: your account is now ${CUSTODY[to].title}. Your 12 words control your identity.`,
        next: to !== 'custodial' && mode === 'custodial' ? 'recovery' : undefined,
      });
      close();
      await ctx.refresh();
    } catch (e) {
      const reason = (e as Error).message.replace(/\.+$/, '');
      setMessage({ ok: false, text: `${reason}. Nothing was changed unless this message says otherwise.` });
      // Existing words may be mistyped: ask again. New words were written down: keep them.
      if (mode !== 'custodial') setFlow({ kind: 'switch', to, step: 'words', ack: true, phrase: null });
    } finally { setBusy(false); setPassword(''); }
  }

  async function doRecover(phrase: string) {
    setBusy(true); setMessage(null);
    try {
      const done = await recoverWithNewPhrase({ pdsUrl: THIS_PDS, jwt: accessToken, password, phrase });
      forgetRemembered(did);
      setMessage({
        ok: true,
        text: `Done: your new 12 words control your identity. Until ${new Date(done.cancelUntil).toLocaleString()} your old words can still cancel this. If your old words may have been stolen, tell this server's operator now.`,
        next: 'history',
      });
      setOfferRemember(phrase);
      close();
    } catch (e) {
      setMessage({ ok: false, text: `${(e as Error).message.replace(/\.+$/, '')}. Nothing was changed.` });
    } finally { setBusy(false); setPassword(''); }
  }

  const switchSteps = mode === 'custodial'
    ? ['Understand the change', 'Write down 12 new words', 'Confirm with your password']
    : ['Understand the change', 'Enter your 12 words', 'Confirm with your password'];

  return (
    <>
      <Section
        id="current"
        title="Who controls your identity"
        description={<>Your identity is your permanent ID on the network; whoever holds its keys can change it or move it. <WhatIsThis term="identity" className="mt-1" /></>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-sm">Now: {CUSTODY[mode].title}</Badge>
          <span className="text-sm font-medium">{CUSTODY[mode].short}</span>
        </div>
        <ChoiceExplainer text={CUSTODY[mode]} extra={[{ label: 'If you lose access', text: CUSTODY[mode].restore }]} />
        {mode === 'assisted' && <p className="text-sm"><Link href="#lost" className="underline underline-offset-4 hover:no-underline">Lost your 12 words?</Link></p>}
        {mode === 'self' && <p className="text-sm"><Link href="/account/recovery" className="underline underline-offset-4 hover:no-underline">Set up or use recovery</Link></p>}
      </Section>

      {message && (
        <div className="space-y-2">
          <StatusMessage ok={message.ok} text={message.text} />
          {message.next === 'recovery' && <p className="text-sm">Next, you can <Link href="/account/recovery" className="underline underline-offset-4 hover:no-underline">set up recovery</Link>, in case you lose your 12 words.</p>}
          {message.next === 'history' && <p className="text-sm">The change is listed in <Link href="/account/history" className="underline underline-offset-4 hover:no-underline">Identity changes</Link>.</p>}
        </div>
      )}

      {offerRemember && (
        <PasskeyOffer did={did} handle={handle} phrase={offerRemember} onDone={(r) => { setOfferRemember(null); if (r) setMessage(r); }} />
      )}

      <Section
        id="change"
        title="Change who controls your identity"
        description="Each option says what it means, what you are responsible for, what can go wrong and how to undo it. Read it before you switch."
      >
        {others.length === 0 && <Note>This server offers no other option.</Note>}

        {flow.kind !== 'switch' && others.length > 0 && (
          <ul className="space-y-3">
            {others.map((m) => (
              <li key={m} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1 text-sm">
                  <h3 className="font-semibold">{CUSTODY[m].title}: {CUSTODY[m].short.toLowerCase()}</h3>
                  <p className="text-muted-foreground">{CUSTODY[m].summary}</p>
                </div>
                <Button type="button" variant="outline" className="shrink-0" disabled={flow.kind === 'recover'}
                  onClick={() => { setMessage(null); setFlow({ kind: 'switch', to: m, step: 'understand', ack: false, phrase: null }); }}>
                  Consider {CUSTODY[m].title}…
                </Button>
              </li>
            ))}
          </ul>
        )}

        {flow.kind === 'switch' && (
          <div className="space-y-4 rounded-md border p-4">
            <h3 className="text-base font-semibold">Switch from {CUSTODY[mode].title} to {CUSTODY[flow.to].title}</h3>
            <Steps current={['understand', 'words', 'password'].indexOf(flow.step)} labels={switchSteps} />

            {flow.step === 'understand' && (
              <>
                <p className="text-sm">{switchNote(mode, flow.to)}</p>
                <ChoiceExplainer text={CUSTODY[flow.to]} extra={[{ label: 'If you lose access', text: CUSTODY[flow.to].restore }]} />
                <Acknowledge id="switch-ack" text={switchAck(flow.to)} checked={flow.ack} onChange={(ack) => setFlow({ ...flow, ack })} />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={!flow.ack} onClick={() => setFlow({ ...flow, step: 'words' })}>Continue</Button>
                  <Button type="button" variant="ghost" onClick={close}>Keep {CUSTODY[mode].title}</Button>
                </div>
              </>
            )}

            {flow.step === 'words' && (
              <>
                {mode === 'custodial'
                  ? <NewPhrase onReady={(phrase) => setFlow({ ...flow, phrase, step: 'password' })} />
                  : (
                    <>
                      <p className="text-sm text-muted-foreground">Your 12 words sign the change. They stay on this device.</p>
                      <ExistingPhrase did={did} onReady={(phrase) => setFlow({ ...flow, phrase, step: 'password' })} />
                    </>
                  )}
                <Button type="button" variant="ghost" onClick={close}>Cancel; nothing has changed</Button>
              </>
            )}

            {flow.step === 'password' && flow.phrase && (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (flow.phrase) void doSwitch(flow.to, flow.phrase); }}>
                <div className="space-y-2">
                  <Label htmlFor="custody-password">Your password</Label>
                  <Input id="custody-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <p className="text-xs text-muted-foreground">A password alone can never change who controls your identity; it confirms it is you asking.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!password || busy}>{busy ? 'Switching…' : `Switch to ${CUSTODY[flow.to].title}`}</Button>
                  <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel; nothing has changed</Button>
                </div>
              </form>
            )}
          </div>
        )}
      </Section>

      {mode === 'assisted' && (
        <Section id="lost" title="Lost your 12 words?" description="In Assisted, this server can give you new 12 words after its operator checks who you are.">
          {flow.kind !== 'recover' && (
            <Button type="button" variant="outline" disabled={flow.kind === 'switch'}
              onClick={() => { setMessage(null); setFlow({ kind: 'recover', step: 'understand', ack: false, phrase: null }); }}>
              Get new 12 words…
            </Button>
          )}
          {flow.kind === 'recover' && (
            <div className="space-y-4 rounded-md border p-4">
              <Steps current={['understand', 'words', 'password'].indexOf(flow.step)} labels={['Before you start', 'Write down 12 new words', 'Confirm with your password']} />
              {flow.step === 'understand' && (
                <>
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    <li>Ask this server&apos;s operator to check who you are. They send a code to your email; you read it back to them.</li>
                    <li>Within 30 minutes of that, continue here: you write down new 12 words and confirm with your password.</li>
                    <li>This server signs the change with its backup key and emails you about it.</li>
                    <li>For 72 hours your old 12 words can cancel it. That is what stops someone else from doing this in your name while you still have your words.</li>
                  </ol>
                  <Note>If you still have your old 12 words, you do not need this: they keep working.</Note>
                  <Acknowledge id="recover-ack" text="I understand that this replaces my 12 words, and that my old words can still cancel it for 72 hours." checked={flow.ack} onChange={(ack) => setFlow({ ...flow, ack })} />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={!flow.ack} onClick={() => setFlow({ ...flow, step: 'words' })}>The operator has checked me; continue</Button>
                    <Button type="button" variant="ghost" onClick={close}>Back</Button>
                  </div>
                </>
              )}
              {flow.step === 'words' && (
                <>
                  <NewPhrase onReady={(phrase) => setFlow({ ...flow, phrase, step: 'password' })} />
                  <Button type="button" variant="ghost" onClick={close}>Cancel; nothing has changed</Button>
                </>
              )}
              {flow.step === 'password' && flow.phrase && (
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (flow.phrase) void doRecover(flow.phrase); }}>
                  <div className="space-y-2">
                    <Label htmlFor="recover-password">Your password</Label>
                    <Input id="recover-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={!password || busy}>{busy ? 'Recovering…' : 'Put my new 12 words in charge'}</Button>
                    <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel; nothing has changed</Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </Section>
      )}

      <Section id="posting" title="The key that signs your posts">
        <p className="text-sm text-muted-foreground">{POSTING_KEY_NOTE}</p>
        <div className="space-y-3 rounded-md border border-dashed p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{DEVICE_SIGNING.title}</h3>
            <Badge variant="outline">Coming later</Badge>
          </div>
          <p className="text-sm">{DEVICE_SIGNING.summary}</p>
          <ChoiceExplainer text={DEVICE_SIGNING} extra={[{ label: 'Who can use it', text: DEVICE_SIGNING.availability }]} />
        </div>
      </Section>
    </>
  );
}
