'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Acknowledge, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { NewPhrase } from '@/components/custody/phrase-inputs';
import { StepList } from '@/components/move/move-parts';
import {
  CREATE_STEPS, createPenName, generatePseudonymPhrase, handleTaken, PassRefused,
  type CreateStep, type PenNameEntry, type ServerFacts,
} from '@/lib/pen-names/pen-names';
import type { Pass } from '@/lib/pen-names/pass-file';
import { PEN_CREATE_ACK, PEN_LIMIT } from '@/lib/copy/glossary';
import { PenPasskeyOffer } from './pen-parts';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type Stage = 'understand' | 'words' | 'create' | 'done';

function Steps({ current }: { current: number }) {
  const labels = ['Choose a name and read the limits', 'Write down its 12 words', 'Create it'];
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

/** Any of the loaded passes: no order the server could learn anything from. */
function anyPass(passes: Pass[]): Pass {
  // Rejection sampling: draws above the largest multiple of n are retried, so
  // every pass is exactly equally likely (plain modulo is slightly biased).
  const n = passes.length;
  const limit = Math.floor(0x100000000 / n) * n;
  const draw = new Uint32Array(1);
  do crypto.getRandomValues(draw); while (draw[0] >= limit);
  return passes[draw[0] % n];
}

/**
 * Create a pen name: name, the honest limit and the no-recovery
 * confirmation, 12 words shown once and checked, then creation with one of
 * the loaded passes and no credentials at all. `ownerDid` is the account the
 * passes came with; it is sealed into the pen name, never sent.
 */
export function CreateSection({ server, ownerDid, passes, scope, onPassUsed, onCreated, onUse }: {
  server: ServerFacts;
  ownerDid: string;
  passes: Pass[];
  scope: string;
  /** The pass was spent (or refused as spent): drop it from what is loaded. */
  onPassUsed: (pass: Pass) => void;
  onCreated: (entry: PenNameEntry) => void;
  onUse: (entry: PenNameEntry, phrase: string) => void | Promise<void>;
}) {
  const domain = server.handleDomains[0] ?? '';
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('understand');
  const [label, setLabel] = useState('');
  const [ack, setAck] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [step, setStep] = useState<CreateStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** A pass was refused after the pen name was put in the directory: retry with another, or stop. */
  const [refused, setRefused] = useState<{ did: string; text: string } | null>(null);
  const [created, setCreated] = useState<PenNameEntry | null>(null);
  const [passkeyDone, setPasskeyDone] = useState<{ ok: boolean; text: string } | null | undefined>(undefined);

  const clean = label.trim().toLowerCase();
  const handle = `${clean}${domain}`;
  const labelOk = LABEL.test(clean);

  function reset() {
    setOpen(false); setStage('understand'); setLabel(''); setAck(false); setPhrase(null);
    setStep(null); setProblem(null); setRefused(null); setCreated(null); setPasskeyDone(undefined);
  }

  async function toWords() {
    setBusy(true); setProblem(null);
    try {
      if (await handleTaken(server.url, handle)) { setProblem(`${handle} is taken. Choose another name.`); return; }
      setStage('words');
    } finally { setBusy(false); }
  }

  async function create(existingDid?: string) {
    if (!phrase || !passes.length) return;
    setBusy(true); setProblem(null); setRefused(null);
    const pass = anyPass(passes);
    try {
      const entry = await createPenName({ server, ownerDid, phrase, handle, pass, scope, existingDid, onStep: setStep });
      onPassUsed(pass);
      setCreated(entry);
      setStage('done');
      onCreated(entry);
    } catch (e) {
      if (e instanceof PassRefused) {
        onPassUsed(pass);
        setRefused({ did: e.did, text: e.message });
      } else {
        setProblem((e as Error).message);
      }
    } finally { setBusy(false); }
  }

  return (
    <Section id="create" title="Create a pen name" description={<>A new identity with its own 12 words, made in this browser. <WhatIsThis term="pen-name-words" label="What are a pen name’s 12 words?" className="mt-1" /></>}>
      {!open && (
        <Button type="button" disabled={passes.length === 0} onClick={() => setOpen(true)}>Create a pen name…</Button>
      )}

      {open && (
        <div className="space-y-4 rounded-md border p-4">
          {stage !== 'done' && <Steps current={stage === 'understand' ? 0 : stage === 'words' ? 1 : 2} />}

          {stage === 'understand' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="pen-label">Its name</Label>
                <div className="flex flex-wrap items-center gap-1">
                  <Input id="pen-label" className="max-w-56" autoComplete="off" spellCheck={false} value={label}
                    onChange={(e) => { setLabel(e.target.value); setProblem(null); }} aria-describedby="pen-label-hint" />
                  <span className="text-sm text-muted-foreground">{domain}</span>
                </div>
                <p id="pen-label-hint" className="text-xs text-muted-foreground">
                  Lowercase letters, digits and hyphens. Pick a name that says nothing about you: it is public.
                </p>
              </div>
              <div className="space-y-2 rounded-md border border-amber-600/40 p-3 text-sm">
                <h3 className="font-semibold">What this protects, and what it doesn&apos;t</h3>
                <p>{PEN_LIMIT.server}</p>
                <p>{PEN_LIMIT.timing}</p>
                <p className="font-medium">{PEN_LIMIT.better}</p>
              </div>
              <Acknowledge id="pen-ack" text={PEN_CREATE_ACK} checked={ack} onChange={setAck} />
              {problem && <StatusMessage ok={false} text={problem} />}
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!ack || !labelOk || busy} onClick={toWords}>{busy ? 'Checking the name…' : 'Continue'}</Button>
                <Button type="button" variant="ghost" onClick={reset}>Not now</Button>
              </div>
              {clean && !labelOk && <p className="text-sm text-muted-foreground">That name has characters a handle cannot have.</p>}
            </>
          )}

          {stage === 'words' && (
            <>
              <NewPhrase
                generate={generatePseudonymPhrase}
                listLabel="The pen name's 12 words"
                intro={`These 12 words are ${handle}. Write them on paper, in order, and keep the paper somewhere safe and private, apart from your own 12 words. Whoever has them can act as the pen name. There is no recovery, and this page will not show them again.`}
                onReady={(p) => { setPhrase(p); setStage('create'); }}
              />
              <Button type="button" variant="ghost" onClick={reset}>Cancel; nothing has been created</Button>
            </>
          )}

          {stage === 'create' && (
            <>
              <p className="text-sm">
                Ready to create <span className="font-medium">{handle}</span>. This uses one of the {passes.length} {passes.length === 1 ? 'pass' : 'passes'} you loaded.
                The request carries nothing about you: no session, no name.
              </p>
              {(busy || step) && <StepList steps={CREATE_STEPS} current={step} failed={!!problem || !!refused} done={false} />}
              {problem && <StatusMessage ok={false} text={problem} />}
              {refused ? (
                <div className="space-y-3 rounded-md border border-amber-600/40 p-3 text-sm" role="alert">
                  <p className="font-medium">{refused.text} The pen name is not created yet.</p>
                  {passes.length > 0 ? (
                    <>
                      <p>
                        You can finish it with another pass ({passes.length} left). If you do, the server sees a used pass and then a fresh one,
                        from the same place, one right after the other: it can guess that whoever made the pen name the used pass was spent on also made this one.
                        It still cannot tell who you are.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={() => void create(refused.did)} disabled={busy}>{busy ? 'Creating…' : 'Finish it with another pass'}</Button>
                        <Button type="button" variant="ghost" onClick={reset} disabled={busy}>Stop here</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>There are no other passes loaded. Load more and try again, or stop here: nothing is linked to you either way.</p>
                      <Button type="button" variant="ghost" onClick={reset}>Stop here</Button>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void create()} disabled={busy || !passes.length}>{busy ? 'Creating…' : `Create ${handle}`}</Button>
                  <Button type="button" variant="ghost" onClick={reset} disabled={busy}>Cancel</Button>
                </div>
              )}
            </>
          )}

          {stage === 'done' && created && phrase && (
            <>
              <StepList steps={CREATE_STEPS} current={null} failed={false} done />
              <StatusMessage ok text={`${created.handle} exists. Its 12 words are on your paper and nowhere else; this page forgets them when you leave it.`} />
              {passkeyDone === undefined && (
                <PenPasskeyOffer penDid={created.did} phrase={phrase} onDone={(r) => setPasskeyDone(r)} />
              )}
              {passkeyDone && <StatusMessage ok={passkeyDone.ok} text={passkeyDone.text} />}
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={async () => { await onUse(created, phrase); reset(); }}>Sign in as {created.handle}</Button>
                <Button type="button" variant="outline" onClick={reset}>Done</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
