'use client';

import { useEffect, useState } from 'react';
import {
  generateRecoveryPhrase, splitRecoveryPhrase, combineRecoveryShares, parseRecoveryShare,
  type RecoveryShare,
} from '@open-federation/sdk/custody';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  assertPhraseBelongs, currentRecoveryKey, setUpRecovery, removeRecovery, assertRecoveryPhraseBelongs, recoverWithRecoveryPhrase,
  type RecoveryMode,
} from '@/lib/custody/custody';
import { RECOVERY, recoveryAck, removeRecoveryAck } from '@/lib/copy/glossary';
import { Acknowledge, ChoiceExplainer, StatusMessage } from '@/components/account/explain';
import { ExistingPhrase, NewPhrase, TypedPhrase } from './phrase-inputs';
import { QrCode } from './qr-code';
import { THIS_PDS } from '@/lib/this-pds';

/**
 * Account → Recovery (#238, ADR-003 decision 13; words from #404). An
 * optional second key the person holds, kept as a backup phrase or split
 * into shares among contacts or with their newsroom. Made and used here;
 * this server never sees the key or the shares and does not know which
 * option was chosen.
 */

const pdsUrl = THIS_PDS;

type Kind = 'phrase' | 'contacts' | 'newsroom';

type Step =
  | { at: 'idle' }
  | { at: 'choose'; kind: Kind; k: number; n: number; ack: boolean }
  | { at: 'identity'; kind: Kind; k: number; n: number }
  | { at: 'backup'; phrase: string }
  | { at: 'shares'; kind: Kind; phrase: string; recoveryPhrase: string; shares: RecoveryShare[]; shown: number; handed: boolean }
  | { at: 'remove'; ack: boolean }
  | { at: 'recover' }
  | { at: 'recover-phrase' }
  | { at: 'recover-shares' }
  | { at: 'recover-new'; recoveryPhrase: string };

function holderOf(kind: Kind, index: number): string {
  if (kind === 'newsroom') return index === 1 ? 'your newsroom' : index === 2 ? 'you (keep it apart from your 12 words)' : 'someone you trust';
  return 'someone you trust';
}

function shortKey(didKey: string): string {
  return `${didKey.slice(0, 16)}…${didKey.slice(-6)}`;
}

export function RecoverySection({ did, mode, onActive, onChanged, onRecovered }: {
  did: string;
  mode: RecoveryMode;
  /** True while a recovery step is open, so the card can hide its other actions. */
  onActive: (active: boolean) => void;
  /** The DID changed (reload the list of changes). */
  onChanged: () => void;
  /** Recovered with new 12 words (offer the passkey for them). */
  onRecovered: (newPhrase: string) => void;
}) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [step, setStepState] = useState<Step>({ at: 'idle' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let alive = true;
    currentRecoveryKey(pdsUrl, did, mode).then((k) => { if (alive) setKey(k); }, () => { if (alive) setKey(undefined); });
    return () => { alive = false; };
  }, [did, mode, reloads]);

  const setStep = (next: Step) => { setStepState(next); onActive(next.at !== 'idle'); };
  const close = () => setStep({ at: 'idle' });
  const failed = (e: unknown, suffix = ' Nothing was changed.') => setMessage({ ok: false, text: (e as Error).message.replace(/\.+$/, '') + '.' + suffix });

  async function turnOn(phrase: string, recoveryPhrase: string, what: string) {
    setBusy(true); setMessage(null);
    try {
      await setUpRecovery({ pdsUrl, did, mode, phrase, recoveryPhrase });
      setMessage({ ok: true, text: `Recovery is on: ${what}` });
      close(); setReloads((n) => n + 1); onChanged();
    } catch (e) {
      failed(e, ' Recovery is not on; the words or shares just shown are not needed.');
    } finally { setBusy(false); }
  }

  async function remove(phrase: string) {
    setBusy(true); setMessage(null);
    try {
      await removeRecovery({ pdsUrl, did, mode, phrase });
      setMessage({ ok: true, text: 'Recovery is off. The backup phrase or shares made for it no longer do anything; you can destroy them.' });
      close(); setReloads((n) => n + 1); onChanged();
    } catch (e) { failed(e); } finally { setBusy(false); }
  }

  async function checkRecoveryPhrase(recoveryPhrase: string) {
    setBusy(true); setMessage(null);
    try {
      await assertRecoveryPhraseBelongs(pdsUrl, did, mode, recoveryPhrase);
      setStep({ at: 'recover-new', recoveryPhrase });
    } catch (e) { failed(e); } finally { setBusy(false); }
  }

  async function recover(recoveryPhrase: string, newPhrase: string) {
    setBusy(true); setMessage(null);
    try {
      const { cancelUntil } = await recoverWithRecoveryPhrase({ pdsUrl, did, mode, recoveryPhrase, newPhrase });
      setMessage({
        ok: true,
        text: `Recovered: your new 12 words control your identity. Until ${cancelUntil.toLocaleString()} your old words can still cancel this (see Identity changes). If your backup phrase or shares may have been seen by someone else, remove recovery and set it up again.`,
      });
      close(); setReloads((n) => n + 1); onChanged(); onRecovered(newPhrase);
    } catch (e) { failed(e); } finally { setBusy(false); }
  }

  const none = mode === 'self'
    ? 'No recovery is set up. If you lose your 12 words, nobody can give you back control of your identity, including this server.'
    : 'No recovery of your own is set up. If you lose your 12 words, this server\'s operator can give you new ones after checking who you are.';

  return (
    <div className="space-y-3">
      <div className="space-y-1" aria-live="polite">
        <h3 className="text-sm font-semibold">{key === undefined ? 'Checking…' : key === null ? 'Recovery is off' : 'Recovery is on'}</h3>
        {key === undefined && <p className="text-sm text-muted-foreground">Reading your identity from the public directory…</p>}
        {key === null && <p className="text-sm text-muted-foreground">{none}</p>}
        {key && (
          <p className="text-sm text-muted-foreground">
            Your identity has a recovery key, kept as a backup phrase or as shares; this server does not know which.
            Whoever holds it can start a recovery, which your 12 words can cancel for 72 hours.
            <span className="mt-1 block font-mono text-xs">Recovery key: {shortKey(key)}</span>
          </p>
        )}
      </div>

      {step.at === 'idle' && key !== undefined && (
        <div className="flex flex-wrap gap-2">
          {key === null && <Button type="button" onClick={() => { setMessage(null); setStep({ at: 'choose', kind: 'phrase', k: 2, n: 3, ack: false }); }}>Set up recovery…</Button>}
          {key && <Button type="button" variant="outline" onClick={() => { setMessage(null); setStep({ at: 'recover' }); }}>Lost your 12 words? Recover with your backup</Button>}
          {key && <Button type="button" variant="ghost" onClick={() => { setMessage(null); setStep({ at: 'remove', ack: false }); }}>Remove recovery…</Button>}
        </div>
      )}

      {step.at === 'choose' && (
        <div className="space-y-4 rounded-md border p-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">How do you want to keep your backup?</legend>
            {(['phrase', 'contacts', 'newsroom'] as Kind[]).map((kind) => (
              <label key={kind} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm focus-within:ring-[3px] focus-within:ring-ring/50 ${step.kind === kind ? 'border-primary bg-muted/60' : ''}`}>
                <input type="radio" name="recovery-kind" className="mt-1" checked={step.kind === kind} onChange={() => setStep({ ...step, kind, ack: false })} />
                <span>
                  <span className="font-medium">{RECOVERY[kind].title}</span>
                  {step.kind === kind && <span className="ml-2 text-xs font-medium">(selected)</span>}
                  <span className="block text-muted-foreground">{RECOVERY[kind].summary}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {step.kind !== 'phrase' && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="recovery-n">Number of shares</Label>
              <select id="recovery-n" className="h-9 rounded-md border bg-background px-2" value={step.n}
                onChange={(e) => { const n = Number(e.target.value); setStep({ ...step, n, k: Math.min(step.k, n), ack: false }); }}>
                {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <Label htmlFor="recovery-k">needed to recover</Label>
              <select id="recovery-k" className="h-9 rounded-md border bg-background px-2" value={step.k}
                onChange={(e) => setStep({ ...step, k: Number(e.target.value), ack: false })}>
                {Array.from({ length: step.n - 1 }, (_, i) => i + 2).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <span className="basis-full text-muted-foreground">Any {step.k} of the {step.n} shares together recover your identity{step.kind === 'newsroom' ? '; your newsroom holds exactly one' : ''}. Fewer learn nothing.</span>
            </div>
          )}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">{RECOVERY[step.kind].title}: before you choose</h4>
            <ChoiceExplainer text={RECOVERY[step.kind]} extra={[{ label: 'Who must help to recover', text: RECOVERY[step.kind].who }, { label: 'Protects you against', text: RECOVERY[step.kind].protects }]} />
          </div>
          <Acknowledge id="recovery-ack" text={recoveryAck(step.kind, step.k)} checked={step.ack} onChange={(ack) => setStep({ ...step, ack })} />
          <p className="text-sm text-muted-foreground">Next, your 12 words sign the change. Nothing about your choice or who holds what is sent to this server.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!step.ack} onClick={() => setStep({ at: 'identity', kind: step.kind, k: step.k, n: step.n })}>Continue</Button>
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </div>
      )}

      {step.at === 'identity' && (
        <div className="space-y-3 rounded-md border p-4">
          <h4 className="text-sm font-semibold">Your 12 words</h4>
          <p className="text-sm text-muted-foreground">They sign the change that adds your recovery key. They stay on this device.</p>
          {busy ? <p className="text-sm text-muted-foreground">Checking…</p> : <ExistingPhrase did={did} onReady={async (phrase) => {
            // Check the phrase before showing anything to write down.
            setBusy(true); setMessage(null);
            try { await assertPhraseBelongs(pdsUrl, did, phrase); } catch (e) { failed(e); return; } finally { setBusy(false); }
            if (step.kind === 'phrase') { setStep({ at: 'backup', phrase }); return; }
            const recoveryPhrase = generateRecoveryPhrase();
            const shares = splitRecoveryPhrase(recoveryPhrase, { threshold: step.k, shares: step.n });
            setStep({ at: 'shares', kind: step.kind, phrase, recoveryPhrase, shares, shown: 0, handed: false });
          }} />}
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
        </div>
      )}

      {step.at === 'backup' && (
        <div className="space-y-3 rounded-md border p-4">
          <h4 className="text-sm font-semibold">Your backup phrase</h4>
          {busy
            ? <p className="text-sm text-muted-foreground">Adding your recovery key…</p>
            : <NewPhrase intro="These are not your 12 words: they are your backup phrase. Write them on paper, in order, and keep them in a different place from your 12 words (another building, a safe). With them you can recover your identity if you lose your 12 words. This page will not show them again." onReady={(recoveryPhrase) => turnOn(step.phrase, recoveryPhrase, 'keep your backup phrase safe and apart from your 12 words.')} />}
          {!busy && <Button type="button" variant="ghost" onClick={close}>Cancel</Button>}
        </div>
      )}

      {step.at === 'shares' && (() => {
        const share = step.shares[step.shown];
        const last = step.shown === step.shares.length - 1;
        const label = `Share ${share.index} of ${step.shares.length}`;
        return (
          <div className="space-y-3 rounded-md border p-4">
            <h4 className="text-sm font-semibold">{label}: for {holderOf(step.kind, share.index)}</h4>
            <p className="text-sm">
              {step.kind === 'newsroom' && share.index === 2
                ? 'Keep this one yourself: write it down and keep it apart from your 12 words.'
                : `Hand this to ${step.kind === 'newsroom' && share.index === 1 ? 'your newsroom' : 'someone you trust'}, in person or on paper.`}{' '}
              Any {share.threshold} shares together recover your identity; one alone is useless. This page will not show it again.
            </p>
            <div className="space-y-3">
              <QrCode text={share.code} label={`${label}, as a QR code`} />
              <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 font-mono text-sm sm:grid-cols-4" aria-label={`${label}, 20 words`}>
                {share.words.split(' ').map((w, i) => <li key={i}><span className="text-muted-foreground">{i + 1}.</span> {w}</li>)}
              </ol>
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">{share.code}</p>
            <Acknowledge id={`share-handed-${share.index}`} text="This share is written down or with its holder, and nobody else has seen it." checked={step.handed} onChange={(handed) => setStep({ ...step, handed })} />
            <div className="flex flex-wrap gap-2">
              {!last && <Button type="button" disabled={!step.handed} onClick={() => setStep({ ...step, shown: step.shown + 1, handed: false })}>Next share</Button>}
              {last && (
                <Button type="button" disabled={!step.handed || busy} onClick={() => turnOn(step.phrase, step.recoveryPhrase,
                  `any ${share.threshold} of the ${step.shares.length} shares recover your identity. This server does not know who holds them.`)}>
                  {busy ? 'Adding your recovery key…' : 'Turn on recovery'}
                </Button>
              )}
              <Button type="button" variant="ghost" className="h-auto whitespace-normal text-left" onClick={close} disabled={busy}>Cancel (the shares shown so far will not work)</Button>
            </div>
          </div>
        );
      })()}

      {step.at === 'remove' && (
        <div className="space-y-3 rounded-md border p-4">
          <h4 className="text-sm font-semibold">Remove recovery</h4>
          <p className="text-sm text-muted-foreground">Your 12 words sign it. Afterwards the backup phrase or shares no longer work. You can set recovery up again later, while you have your 12 words.</p>
          <Acknowledge id="remove-ack" text={removeRecoveryAck(mode)} checked={step.ack} onChange={(ack) => setStep({ ...step, ack })} disabled={busy} />
          {step.ack && (busy ? <p className="text-sm text-muted-foreground">Removing…</p> : <ExistingPhrase did={did} onReady={remove} />)}
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        </div>
      )}

      {step.at === 'recover' && (
        <div className="space-y-3 rounded-md border p-4">
          <h4 className="text-sm font-semibold">Recover with your backup</h4>
          <p className="text-sm text-muted-foreground">
            You get new 12 words. Your old 12 words can cancel this for 72 hours, so a recovery someone else starts fails while the real words still exist.
            If you still have your 12 words, you do not need this.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setStep({ at: 'recover-phrase' })}>I have my backup phrase</Button>
            <Button type="button" variant="outline" onClick={() => setStep({ at: 'recover-shares' })}>I have shares</Button>
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </div>
      )}

      {step.at === 'recover-phrase' && (
        <div className="space-y-3 rounded-md border p-4">
          <TypedPhrase id="recovery-phrase" label="Your backup phrase (12 words)" action={busy ? 'Checking…' : 'Continue'} onReady={checkRecoveryPhrase} />
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        </div>
      )}

      {step.at === 'recover-shares' && (
        <div className="space-y-3 rounded-md border p-4">
          <ShareCollector busy={busy} onReady={checkRecoveryPhrase} />
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        </div>
      )}

      {step.at === 'recover-new' && (
        <div className="space-y-3 rounded-md border p-4">
          <h4 className="text-sm font-semibold">Your new 12 words</h4>
          {busy
            ? <p className="text-sm text-muted-foreground">Putting your new 12 words in charge…</p>
            : <NewPhrase onReady={(newPhrase) => recover(step.recoveryPhrase, newPhrase)} />}
          {!busy && <Button type="button" variant="ghost" onClick={close}>Cancel</Button>}
        </div>
      )}

      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </div>
  );
}

/** Shares typed (20 words) or pasted (an OFRS: code, for example from a phone's QR scanner), checked as they come in. */
function ShareCollector({ busy, onReady }: { busy: boolean; onReady: (recoveryPhrase: string) => void }) {
  const [texts, setTexts] = useState<string[]>(['', '']);
  type Read = { share: RecoveryShare; problem?: undefined } | { share?: undefined; problem: string } | null;
  const parsed: Read[] = texts.map((t) => {
    if (!t.trim()) return null;
    try { return { share: parseRecoveryShare(t) }; } catch (e) { return { problem: (e as Error).message }; }
  });
  const good = parsed.flatMap((p) => (p?.share ? [p.share] : []));
  let combined: { phrase: string } | { problem: string } | null = null;
  if (good.length > 0 && good.length >= good[0].threshold) {
    try { combined = { phrase: combineRecoveryShares(good) }; } catch (e) { combined = { problem: (e as Error).message }; }
  }
  const needed = good[0]?.threshold;
  const distinct = new Set(good.map((s) => s.index)).size;
  return (
    <div className="space-y-3">
      <p className="text-sm">Enter each share: its 20 words, or the code under its QR code (scan it with your phone&apos;s camera and paste the text).</p>
      {texts.map((t, i) => (
        <div key={i} className="space-y-1">
          <Label htmlFor={`share-${i}`}>Share {i + 1}</Label>
          <Textarea id={`share-${i}`} autoComplete="off" spellCheck={false} className="font-mono" value={t}
            onChange={(e) => setTexts(texts.map((x, j) => (j === i ? e.target.value : x)))} />
          {parsed[i]?.share && <p className="text-sm text-green-800 dark:text-green-400">✓ Share {parsed[i]?.share?.index} checks out (any {parsed[i]?.share?.threshold} shares recover).</p>}
          {parsed[i]?.problem && <p className="text-sm text-destructive">{parsed[i]?.problem}.</p>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setTexts([...texts, ''])}>Add another share</Button>
        {needed && <span className="text-sm text-muted-foreground">{Math.min(distinct, needed)} of the {needed} shares needed.</span>}
      </div>
      {combined && 'problem' in combined && <p className="text-sm text-destructive">{combined.problem}.</p>}
      <Button type="button" disabled={!combined || !('phrase' in combined) || busy} onClick={() => combined && 'phrase' in combined && onReady(combined.phrase)}>
        {busy ? 'Checking…' : 'Continue'}
      </Button>
    </div>
  );
}
