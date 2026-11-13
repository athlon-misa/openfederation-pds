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
import { ExistingPhrase, NewPhrase, TypedPhrase } from './phrase-inputs';
import { QrCode } from './qr-code';

/**
 * Settings → Identity custody → Recovery (#238, ADR-003 decision 13). An
 * optional second key the person holds, kept as a backup phrase or split
 * into shares among contacts or with their newsroom. Made and used here;
 * this server never sees the key or the shares and does not know which
 * option was chosen.
 */

const pdsUrl = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

type Kind = 'phrase' | 'contacts' | 'newsroom';

const KINDS: Record<Kind, { title: string; what: string }> = {
  phrase: {
    title: 'Backup phrase',
    what: 'A second set of 12 words, kept whole: on paper, in a safe, away from your identity phrase.',
  },
  contacts: {
    title: 'Split among contacts',
    what: 'Shares for people you trust (an editor, a colleague, a lawyer). Any few of them together can recover your identity; fewer learn nothing.',
  },
  newsroom: {
    title: 'With my newsroom',
    what: 'Your newsroom holds one share; you and people you trust hold the others. Your newsroom can never recover on its own, even if it runs this server.',
  },
};

type Step =
  | { at: 'idle' }
  | { at: 'choose'; kind: Kind; k: number; n: number }
  | { at: 'identity'; kind: Kind; k: number; n: number }
  | { at: 'backup'; phrase: string }
  | { at: 'shares'; kind: Kind; phrase: string; recoveryPhrase: string; shares: RecoveryShare[]; shown: number; handed: boolean }
  | { at: 'remove' }
  | { at: 'recover' }
  | { at: 'recover-phrase' }
  | { at: 'recover-shares' }
  | { at: 'recover-new'; recoveryPhrase: string };

function holderOf(kind: Kind, index: number): string {
  if (kind === 'newsroom') return index === 1 ? 'your newsroom' : index === 2 ? 'you (keep it apart from your phrase)' : 'someone you trust';
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
  /** Recovered with a new identity phrase (offer the passkey for it). */
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
      setMessage({ ok: true, text: 'Recovery is off. Backup phrases or shares made for it no longer do anything; you can destroy them.' });
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
        text: `Recovered: your new phrase controls your identity. Until ${cancelUntil.toLocaleString()} the old phrase can still cancel this (see Changes to your identity). If your backup phrase or shares may have been seen, remove recovery and set it up again.`,
      });
      close(); setReloads((n) => n + 1); onChanged(); onRecovered(newPhrase);
    } catch (e) { failed(e); } finally { setBusy(false); }
  }

  const none = mode === 'self'
    ? 'No recovery is set up. If you lose your phrase, nobody can restore your identity, including this server.'
    : 'No recovery key of your own. If you lose your phrase, this server\'s operator can restore it after checking who you are.';

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Recovery</p>
        {key === undefined && <p className="text-sm text-muted-foreground">Reading your identity from the PLC directory…</p>}
        {key === null && <p className="text-sm text-muted-foreground">{none}</p>}
        {key && (
          <p className="text-sm text-muted-foreground">
            A recovery key is set (<span className="font-mono text-xs">{shortKey(key)}</span>), kept as a backup phrase or as shares; this server does not know which.
            Whoever holds it can start a recovery, which your phrase can cancel for 72 hours.
          </p>
        )}
      </div>

      {step.at === 'idle' && key !== undefined && (
        <div className="flex flex-wrap gap-2">
          {key === null && <Button type="button" variant="outline" onClick={() => { setMessage(null); setStep({ at: 'choose', kind: 'phrase', k: 2, n: 3 }); }}>Set up recovery</Button>}
          {key && <Button type="button" variant="outline" onClick={() => { setMessage(null); setStep({ at: 'recover' }); }}>Lost your phrase? Recover with your backup</Button>}
          {key && <Button type="button" variant="ghost" onClick={() => { setMessage(null); setStep({ at: 'remove' }); }}>Remove recovery</Button>}
        </div>
      )}

      {step.at === 'choose' && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">How do you want to keep your recovery key?</p>
          <div className="space-y-2" role="radiogroup" aria-label="Recovery option">
            {(Object.keys(KINDS) as Kind[]).map((kind) => (
              <label key={kind} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${step.kind === kind ? 'border-primary' : ''}`}>
                <input type="radio" name="recovery-kind" className="mt-1" checked={step.kind === kind} onChange={() => setStep({ ...step, kind })} />
                <span><span className="font-medium">{KINDS[kind].title}</span><span className="block text-muted-foreground">{KINDS[kind].what}</span></span>
              </label>
            ))}
          </div>
          {step.kind !== 'phrase' && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="recovery-n">Shares</Label>
              <select id="recovery-n" className="h-9 rounded-md border bg-background px-2" value={step.n}
                onChange={(e) => { const n = Number(e.target.value); setStep({ ...step, n, k: Math.min(step.k, n) }); }}>
                {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <Label htmlFor="recovery-k">needed to recover</Label>
              <select id="recovery-k" className="h-9 rounded-md border bg-background px-2" value={step.k}
                onChange={(e) => setStep({ ...step, k: Number(e.target.value) })}>
                {Array.from({ length: step.n - 1 }, (_, i) => i + 2).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <span className="text-muted-foreground">Any {step.k} of the {step.n} recover your identity{step.kind === 'newsroom' ? '; your newsroom holds one' : ''}.</span>
            </div>
          )}
          <p className="text-sm text-muted-foreground">Next, your identity phrase signs the change. Nothing about your choice or who holds what is sent to this server.</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setStep({ at: 'identity', kind: step.kind, k: step.k, n: step.n })}>Continue</Button>
            <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </div>
      )}

      {step.at === 'identity' && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Your identity phrase</p>
          <p className="text-sm text-muted-foreground">It signs the change that adds your recovery key. It stays on this device.</p>
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
          <p className="text-sm font-medium">Your backup phrase</p>
          {busy
            ? <p className="text-sm text-muted-foreground">Adding your recovery key…</p>
            : <NewPhrase intro="Write these 12 words on paper, in order, and keep them apart from your identity phrase (another place, a safe). With them you can recover your identity if you lose your phrase. This page will not show them again." onReady={(recoveryPhrase) => turnOn(step.phrase, recoveryPhrase, 'keep your backup phrase safe and apart from your identity phrase.')} />}
          {!busy && <Button type="button" variant="ghost" onClick={close}>Cancel</Button>}
        </div>
      )}

      {step.at === 'shares' && (() => {
        const share = step.shares[step.shown];
        const last = step.shown === step.shares.length - 1;
        const label = `Share ${share.index} of ${step.shares.length}`;
        return (
          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm font-medium">{label}: for {holderOf(step.kind, share.index)}</p>
            <p className="text-sm">
              {step.kind === 'newsroom' && share.index === 2
                ? 'Keep this one yourself: write it down and keep it apart from your phrase.'
                : `Hand this to ${step.kind === 'newsroom' && share.index === 1 ? 'your newsroom' : 'someone you trust'}, in person or on paper.`}{' '}
              Any {share.threshold} shares together recover your identity; one alone is useless. This page will not show it again.
            </p>
            <div className="space-y-3">
              <QrCode text={share.code} label={`${label}, as a QR code`} />
              <ol className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 font-mono text-sm" aria-label={`${label}, 20 words`}>
                {share.words.split(' ').map((w, i) => <li key={i}><span className="text-muted-foreground">{i + 1}.</span> {w}</li>)}
              </ol>
            </div>
            <p className="break-all font-mono text-xs text-muted-foreground">{share.code}</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={step.handed} onChange={(e) => setStep({ ...step, handed: e.target.checked })} />
              This share is written down or with its holder
            </label>
            <div className="flex gap-2">
              {!last && <Button type="button" disabled={!step.handed} onClick={() => setStep({ ...step, shown: step.shown + 1, handed: false })}>Next share</Button>}
              {last && (
                <Button type="button" disabled={!step.handed || busy} onClick={() => turnOn(step.phrase, step.recoveryPhrase,
                  `any ${share.threshold} of the ${step.shares.length} shares recover your identity. This server does not know who holds them.`)}>
                  {busy ? 'Adding your recovery key…' : 'Turn on recovery'}
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel (the shares shown so far will not work)</Button>
            </div>
          </div>
        );
      })()}

      {step.at === 'remove' && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Remove recovery</p>
          <p className="text-sm text-muted-foreground">Your identity phrase signs it. Afterwards the backup phrase or shares no longer work.</p>
          {busy ? <p className="text-sm text-muted-foreground">Removing…</p> : <ExistingPhrase did={did} onReady={remove} />}
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        </div>
      )}

      {step.at === 'recover' && (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">Recover with your recovery key</p>
          <p className="text-sm text-muted-foreground">
            You get a new identity phrase. Your old phrase can cancel this for 72 hours, so a recovery someone else starts fails while the real phrase still exists.
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
          <p className="text-sm font-medium">Your new identity phrase</p>
          {busy
            ? <p className="text-sm text-muted-foreground">Signing your new phrase in…</p>
            : <NewPhrase onReady={(newPhrase) => recover(step.recoveryPhrase, newPhrase)} />}
          {!busy && <Button type="button" variant="ghost" onClick={close}>Cancel</Button>}
        </div>
      )}

      {message && <p className={`text-sm ${message.ok ? 'text-green-700' : 'text-destructive'}`} role="status">{message.text}</p>}
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
          {parsed[i]?.share && <p className="text-sm text-green-700">Share {parsed[i]?.share?.index} checks out (any {parsed[i]?.share?.threshold} shares recover).</p>}
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
