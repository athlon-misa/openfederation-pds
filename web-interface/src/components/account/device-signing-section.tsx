'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ExistingPhrase, TypedPhrase } from '@/components/custody/phrase-inputs';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from './explain';
import type { AccountContext } from './account-gate';
import { DEVICE_SIGNING, DEVICE_SIGNING_ACK } from '@/lib/copy/glossary';
import {
  cancelSwitchBack, deviceSigningStatus, findSwitchBack, headSignedBy, loadDeviceKey, replaceDevice, resumeDeviceSigning,
  turnOffDeviceSigning, turnOnDeviceSigning, type DeviceSigningStatus, type SwitchBack,
} from '@/lib/custody/device-signing';
import { THIS_PDS } from '@/lib/this-pds';

type Flow =
  | { kind: 'idle' }
  | { kind: 'on' | 'off'; step: 'understand' | 'words'; ack: boolean }
  | { kind: 'replace'; step: 'understand' | 'how' | 'words' | 'backup'; ack: boolean }
  | { kind: 'cancel' };

type Message = { ok: boolean; text: string; next?: 'history' };

const short = (key: string | null) => (key ? `${key.slice(0, 16)}…${key.slice(-6)}` : 'none');
const when = (d: Date | string) => new Date(d).toLocaleString();

/** The four answers plus what it protects, what you give up and losing the device, for this account's mode. */
export function DeviceSigningExplainer({ mode }: { mode: 'assisted' | 'self' }) {
  return (
    <ChoiceExplainer
      text={DEVICE_SIGNING}
      extra={[
        { label: 'What it protects', text: DEVICE_SIGNING.protects },
        { label: 'What you give up', text: DEVICE_SIGNING.givesUp },
        { label: 'If you lose this device', text: `${DEVICE_SIGNING.lostDevice} ${DEVICE_SIGNING.lostAll[mode]}` },
        { label: 'Who can turn it off', text: DEVICE_SIGNING.whoCanUndo[mode] },
      ]}
    />
  );
}

/** What works while device signing is on, as this server reports it. */
export function DeviceSigningFeatures({ features }: { features: DeviceSigningStatus['features'] }) {
  if (features.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">While device signing is on</h3>
      <ul className="divide-y rounded-md border text-sm" aria-label="Features while device signing is on">
        {features.map((f) => (
          <li key={f.id} className="flex items-start justify-between gap-3 p-3">
            <span>{f.title}</span>
            <Badge variant={f.available ? 'secondary' : 'outline'} className="shrink-0">{f.available ? 'Works' : 'Not while it is on'}</Badge>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">This server reports this list. Features move from &quot;Not while it is on&quot; to &quot;Works&quot; as they learn to sign on your device.</p>
    </div>
  );
}

/**
 * Device signing (#240): the setting, in plain words, with turning it on and
 * off, a new device taking over (12 words or backup phrase), and cancelling a
 * switch back by this server's backup key. Custodial accounts and servers
 * that do not offer it get an explanation instead of controls.
 */
export function DeviceSigningSection({ ctx, id = 'device-signing' }: { ctx: AccountContext; id?: string }) {
  const { did, handle, accessToken, mode } = ctx;
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['device-signing', did],
    queryFn: () => deviceSigningStatus(THIS_PDS, accessToken),
  });
  const switchBack = useQuery({
    queryKey: ['device-signing-switch', did],
    enabled: !!status.data && mode !== 'custodial',
    queryFn: () => findSwitchBack(THIS_PDS, did, status.data?.serverKey ?? null),
  });
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [stored, setStored] = useState(() => loadDeviceKey(did));

  const refresh = async () => {
    setStored(loadDeviceKey(did));
    await client.invalidateQueries({ queryKey: ['device-signing', did] });
    await client.invalidateQueries({ queryKey: ['device-signing-switch', did] });
  };

  async function run(action: () => Promise<Message>) {
    setBusy(true); setMessage(null);
    try {
      setMessage(await action());
      setFlow({ kind: 'idle' });
    } catch (e) {
      setMessage({ ok: false, text: `${(e as Error).message.replace(/\.+$/, '')}. Nothing was changed unless this message says otherwise.` });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  /** After this server's key was in charge, say whether it wrote since. */
  async function afterResume(deviceKey: string | null): Promise<Message> {
    const signed = deviceKey ? await headSignedBy(THIS_PDS, did, deviceKey) : null;
    if (signed === false) {
      return { ok: false, text: 'Device signing is on again. But the latest change in your repository was signed by this server\'s key, not your device: while its key was in charge, it could have written in your name. Look through your posts and records before you post again.' };
    }
    return { ok: true, text: 'Device signing is on again: only your device signs your posts.' };
  }

  const title = DEVICE_SIGNING.title;
  const description = <>{DEVICE_SIGNING.summary} <WhatIsThis term="device-signing" className="mt-1" /></>;

  if (status.isLoading) return <Section id={id} title={title} description={description}><Skeleton className="h-24 rounded-md" /></Section>;
  if (status.isError || !status.data) {
    return (
      <Section id={id} title={title} description={description}>
        <StatusMessage ok={false} text={`Could not load the setting: ${(status.error as Error | null)?.message ?? 'no answer'}`} />
      </Section>
    );
  }
  const s = status.data;

  if (mode === 'custodial') {
    return (
      <Section id={id} title={title} description={description}>
        <Note>{DEVICE_SIGNING.custodial} <Link href="/account/identity#change" className="underline underline-offset-4 hover:no-underline">Change who controls your identity</Link></Note>
        <ChoiceExplainer text={DEVICE_SIGNING} extra={[{ label: 'What it protects', text: DEVICE_SIGNING.protects }, { label: 'What you give up', text: DEVICE_SIGNING.givesUp }]} />
      </Section>
    );
  }

  const on = s.deviceSigning;
  const offered = s.allowed || on || s.state === 'resumable';
  if (!offered) {
    return (
      <Section id={id} title={title} description={description}>
        <Note>{DEVICE_SIGNING.notOffered}</Note>
        <DeviceSigningExplainer mode={mode} />
      </Section>
    );
  }

  const holdsKey = !!stored && stored.didKey === s.atprotoKey;
  const sb: SwitchBack | null | undefined = switchBack.data;
  const showSwitchBack = !!sb && sb.cancellable;

  return (
    <Section id={id} title={title} description={description}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={on ? 'secondary' : 'outline'} className="text-sm">{on ? 'On' : 'Off'}</Badge>
        <span className="text-sm font-medium">
          {on ? 'Your device signs your posts; this server cannot post as you.' : 'This server signs your posts.'}
        </span>
      </div>
      {on && (
        <p className="text-sm text-muted-foreground">
          {holdsKey ? 'This device holds the key.' : 'This device does not hold the key: posts can only be signed on the device that does.'}
          {' '}Key in your identity: <span className="font-mono text-xs">{short(s.atprotoKey)}</span>{s.since ? `, on since ${when(s.since)}` : ''}.
        </p>
      )}
      {!s.allowed && on && <Note>This server no longer offers device signing to new people. Yours stays on until you turn it off.</Note>}
      {!s.plcReadable && <StatusMessage ok={false} text="The public directory could not be read just now, so what is shown here may be out of date." />}

      {showSwitchBack && sb && (
        <div className="space-y-3 rounded-md border status-warning p-4 text-sm">
          <p className="font-semibold">
            {sb.toServerKey
              ? `On ${when(sb.createdAt)} this server's backup key switched device signing off.`
              : `On ${when(sb.createdAt)} a backup key put another device in charge of signing your posts.`}
          </p>
          <p>
            The change is public in the directory{sb.toServerKey && mode === 'assisted' ? ', and you should have been emailed' : ''}. If it was you, nothing to do.
            If it was not, cancel it with your 12 words before {when(sb.cancelUntil)}. After that it stays.
          </p>
          {flow.kind !== 'cancel' && <Button type="button" disabled={busy} onClick={() => { setMessage(null); setFlow({ kind: 'cancel' }); }}>Cancel it with my 12 words…</Button>}
          {flow.kind === 'cancel' && (
            <div className="space-y-3">
              <p className="text-muted-foreground">Your 12 words sign an update that puts your identity back as it was before the change. Anything changed after it is undone too.</p>
              {busy ? <p className="text-muted-foreground">Cancelling…</p> : (
                <ExistingPhrase did={did} onReady={(phrase) => run(async () => {
                  await cancelSwitchBack({ pdsUrl: THIS_PDS, jwt: accessToken, did, phrase, change: sb });
                  return { ...(await afterResume(sb.before.verificationMethods.atproto ?? null)), next: 'history' };
                })} />
              )}
              <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })} disabled={busy}>Back</Button>
            </div>
          )}
        </div>
      )}

      {s.state === 'resumable' && (
        <div className="space-y-3 rounded-md border p-4 text-sm">
          <p>Your identity names a key of your own for your posts, but this server has device signing off (for example after you cancelled a switch back). Until it is on again, this server refuses posts signed by your device.</p>
          <Button type="button" disabled={busy} onClick={() => run(async () => { await resumeDeviceSigning({ pdsUrl: THIS_PDS, jwt: accessToken }); return afterResume(s.atprotoKey); })}>
            {busy ? 'Turning on…' : 'Turn device signing back on'}
          </Button>
        </div>
      )}
      {s.state === 'switchedBack' && (
        <StatusMessage ok={false} text="Your identity names this server's key for your posts again. This server will turn device signing off the next time something is signed; if you did not ask for this, cancel the change above." />
      )}

      {message && (
        <div className="space-y-2">
          <StatusMessage ok={message.ok} text={message.text} />
          {message.next === 'history' && <p className="text-sm">The change is listed in <Link href="/account/history" className="underline underline-offset-4 hover:no-underline">Identity changes</Link>.</p>}
        </div>
      )}

      {flow.kind === 'idle' && (
        <>
          <DeviceSigningExplainer mode={mode} />
          <DeviceSigningFeatures features={s.features} />
          <div className="flex flex-wrap gap-2">
            {!on && s.state !== 'resumable' && s.eligible && (
              <Button type="button" onClick={() => { setMessage(null); setFlow({ kind: 'on', step: 'understand', ack: false }); }}>Turn on device signing…</Button>
            )}
            {on && (
              <>
                <Button type="button" variant={holdsKey ? 'outline' : 'default'} onClick={() => { setMessage(null); setFlow({ kind: 'replace', step: 'understand', ack: false }); }}>
                  {holdsKey ? 'Make a new key on this device…' : 'This device takes over…'}
                </Button>
                <Button type="button" variant="outline" onClick={() => { setMessage(null); setFlow({ kind: 'off', step: 'understand', ack: false }); }}>Turn off…</Button>
              </>
            )}
          </div>
        </>
      )}

      {flow.kind === 'on' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="text-base font-semibold">Turn on device signing</h3>
          {flow.step === 'understand' && (
            <>
              <DeviceSigningExplainer mode={mode} />
              <DeviceSigningFeatures features={s.features} />
              <Acknowledge id="ds-on-ack" text={DEVICE_SIGNING_ACK.on} checked={flow.ack} onChange={(ack) => setFlow({ ...flow, ack })} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!flow.ack} onClick={() => setFlow({ ...flow, step: 'words' })}>Continue</Button>
                <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })}>Keep it off</Button>
              </div>
            </>
          )}
          {flow.step === 'words' && (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>This browser makes the key and locks it with a passkey on this device (you will be asked for Face ID, Touch ID, Windows Hello or a security key).</li>
                <li>Your 12 words sign the change that names the key in your public identity.</li>
                <li>This server is told, and stops signing for you.</li>
              </ol>
              {busy ? <p className="text-sm text-muted-foreground">Waiting for the passkey, then the public directory…</p> : (
                <ExistingPhrase did={did} onReady={(phrase) => run(async () => {
                  await turnOnDeviceSigning({ pdsUrl: THIS_PDS, jwt: accessToken, did, handle, phrase });
                  return { ok: true, text: 'Done: this device now signs your posts, and this server can no longer post as you. Keep your 12 words: they are how you put a new device in charge.' };
                })} />
              )}
              <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })} disabled={busy}>Cancel; nothing has changed</Button>
            </>
          )}
        </div>
      )}

      {flow.kind === 'off' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="text-base font-semibold">Turn off device signing</h3>
          {flow.step === 'understand' && (
            <>
              <p className="text-sm">Your 12 words sign the change that names this server&apos;s key in your identity again. From then on this server signs your posts, and the key on this device is forgotten.</p>
              <Acknowledge id="ds-off-ack" text={DEVICE_SIGNING_ACK.off} checked={flow.ack} onChange={(ack) => setFlow({ ...flow, ack })} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!flow.ack} onClick={() => setFlow({ ...flow, step: 'words' })}>Continue</Button>
                <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })}>Keep it on</Button>
              </div>
            </>
          )}
          {flow.step === 'words' && (
            <>
              {busy ? <p className="text-sm text-muted-foreground">Turning off…</p> : (
                <ExistingPhrase did={did} onReady={(phrase) => run(async () => {
                  await turnOffDeviceSigning({ pdsUrl: THIS_PDS, jwt: accessToken, did, phrase });
                  return { ok: true, text: 'Done: this server signs your posts again. You can turn device signing on again at any time.' };
                })} />
              )}
              <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })} disabled={busy}>Cancel; nothing has changed</Button>
            </>
          )}
        </div>
      )}

      {flow.kind === 'replace' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="text-base font-semibold">{holdsKey ? 'Make a new key on this device' : 'This device takes over'}</h3>
          {flow.step === 'understand' && (
            <>
              <p className="text-sm">
                {holdsKey
                  ? 'This browser makes a new key and your identity names it instead of the current one. Do this if you think the key on this device may have been copied.'
                  : 'Use this if you lost the device that signs your posts, or want to post from this one instead. This browser makes a new key; your identity names it, and the other device\'s key stops working.'}
                {' '}Nothing you posted is lost.
              </p>
              <Acknowledge id="ds-replace-ack" text={DEVICE_SIGNING_ACK.replace} checked={flow.ack} onChange={(ack) => setFlow({ ...flow, ack })} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!flow.ack} onClick={() => setFlow({ ...flow, step: 'how' })}>Continue</Button>
                <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })}>Back</Button>
              </div>
            </>
          )}
          {flow.step === 'how' && (
            <>
              <p className="text-sm">What do you have at hand?</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => setFlow({ ...flow, step: 'words' })}>My 12 words</Button>
                <Button type="button" variant="outline" onClick={() => setFlow({ ...flow, step: 'backup' })}>My backup phrase (recovery)</Button>
              </div>
              <Note>
                Lost your 12 words too? {mode === 'assisted' ? <>Get new ones under <Link href="/account/identity#lost" className="underline underline-offset-4 hover:no-underline">Lost your 12 words?</Link> first, </> : <>Use <Link href="/account/recovery" className="underline underline-offset-4 hover:no-underline">Recovery</Link> first (it gives you new 12 words; for a backup split into shares, that is the way), </>}
                then come back here.
              </Note>
              <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })}>Back</Button>
            </>
          )}
          {(flow.step === 'words' || flow.step === 'backup') && (
            <>
              {flow.step === 'backup' && <p className="text-sm text-muted-foreground">A change signed with your backup phrase can be cancelled with your 12 words for 72 hours, like any recovery.</p>}
              {busy ? <p className="text-sm text-muted-foreground">Waiting for the passkey, then the public directory…</p> : flow.step === 'words' ? (
                <ExistingPhrase did={did} onReady={(phrase) => run(async () => {
                  await replaceDevice({ pdsUrl: THIS_PDS, jwt: accessToken, did, handle, mode, with: { phrase } });
                  return { ok: true, text: 'Done: this device now signs your posts. The previous key no longer works.' };
                })} />
              ) : (
                <TypedPhrase id="ds-backup" label="Your backup phrase (12 words)" onReady={(recoveryPhrase) => run(async () => {
                  const done = await replaceDevice({ pdsUrl: THIS_PDS, jwt: accessToken, did, handle, mode, with: { recoveryPhrase } });
                  return { ok: true, text: `Done: this device now signs your posts. Until ${when(done.cancelUntil!)} your 12 words can still cancel this.`, next: 'history' };
                })} />
              )}
              <Button type="button" variant="ghost" onClick={() => setFlow({ kind: 'idle' })} disabled={busy}>Cancel; nothing has changed</Button>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
