'use client';

import { useRef, useState } from 'react';
import type { MoveStep } from '@open-federation/pseudonym';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Acknowledge, ChoiceExplainer, Note, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { StepList } from '@/components/move/move-parts';
import { describeTarget, type TargetInfo } from '@/lib/move/xrpc';
import {
  assertPenWords, downloadBackup, endPenName, movePenName, END_STEPS, PEN_MOVE_STEPS,
  type EndStep, type PenNameEntry, type PenSession,
} from '@/lib/pen-names/pen-names';
import { PEN_END, PEN_MOVE, PEN_MOVE_ACK, penEndAck } from '@/lib/copy/glossary';
import { fileSafe, PenWords, saveFile } from './pen-parts';

const host = (url: string) => url.replace(/^https?:\/\//, '');

/** What the new server says about pen names moving in. */
function penPolicy(target: TargetInfo | null): { text: string; blocked: boolean } {
  if (!target) return { text: '', blocked: false };
  if (!target.migration) return { text: 'That server does not say whether it accepts pen names moving in (it may not be an OpenFederation server). It may refuse; nothing changes if it does.', blocked: false };
  switch (target.migration.pseudonyms) {
    case 'open': return { text: 'That server accepts pen names moving in.', blocked: false };
    case 'token': return { text: 'That server accepts pen names moving in only with one of its own passes. This dashboard cannot hand it one yet; use an app that can, or ask the people who run it.', blocked: true };
    case 'closed': return { text: 'That server does not accept pen names moving in.', blocked: true };
    default: return { text: 'That server did not say whether it accepts pen names moving in.', blocked: false };
  }
}

/** Move the pen name to another server with its 12 words. */
export function MovePenName({ scope, entry, session, plcUrl, penPhrase, onPenPhrase, onMoved }: {
  /** Which list of pen names this browser keeps it in. */
  scope: string;
  entry: PenNameEntry;
  session: PenSession;
  plcUrl: string;
  penPhrase: string | null;
  onPenPhrase: (p: string) => void;
  onMoved: (entry: PenNameEntry) => void;
}) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [handle, setHandle] = useState('');
  const [ack, setAck] = useState(false);
  const [step, setStep] = useState<MoveStep | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const reached = useRef<Set<MoveStep>>(new Set());
  const policy = penPolicy(target);
  const label = session.handle.split('.')[0];

  async function check() {
    setChecking(true); setResult(null); setTarget(null);
    try {
      const t = await describeTarget(url);
      if (t.url.replace(/\/+$/, '') === entry.home.url.replace(/\/+$/, '')) throw new Error(`${session.handle} already lives there.`);
      setTarget(t);
      setHandle(t.handleDomains[0] ? `${label}${t.handleDomains[0]}` : '');
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setChecking(false); }
  }

  async function acceptWords(p: string) {
    setResult(null);
    try { await assertPenWords(plcUrl, entry.did, p); onPenPhrase(p); } catch (e) { setResult({ ok: false, text: (e as Error).message }); }
  }

  async function start() {
    if (!target || !penPhrase) return;
    setRunning(true); setResult(null); reached.current.clear();
    try {
      const moved = await movePenName({
        scope, entry, phrase: penPhrase, plcUrl, target: { url: target.url, serviceDid: target.serviceDid }, newHandle: handle.trim(),
        onStep: (s) => { reached.current.add(s); setStep(s); },
      });
      setStep(null);
      setResult({ ok: true, text: `Done. ${moved.handle} now lives at ${host(target.url)}, and you are signed in as it there. The copy at ${host(entry.home.url)} is switched off.` });
      onMoved(moved);
    } catch (e) {
      const changed = reached.current.has('activate') || reached.current.has('retire');
      setResult({
        ok: false,
        text: changed
          ? `${(e as Error).message}. The pen name already points at ${host(target.url)}: sign in as it there to finish.`
          : `${(e as Error).message}. Nothing changed: ${session.handle} still lives at ${host(entry.home.url)}. The new server may keep an unused, switched-off copy.`,
      });
    } finally { setRunning(false); }
  }

  const canStart = !!target && !policy.blocked && !!handle.trim() && ack && !!penPhrase && !running;

  return (
    <div className="space-y-4">
      <div className="text-sm"><p>{PEN_MOVE.summary}</p><WhatIsThis term="moving" className="mt-1" /></div>
      <ChoiceExplainer text={PEN_MOVE} />
      <div className="space-y-2">
        <Label htmlFor="pen-move-url">Address of the new server</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="pen-move-url" placeholder="https://pds.example.com" value={url} disabled={running}
            onChange={(e) => { setUrl(e.target.value); setTarget(null); }} />
          <Button type="button" variant="outline" onClick={check} disabled={!url.trim() || checking || running}>{checking ? 'Checking…' : 'Check this server'}</Button>
        </div>
        <p className="text-xs text-muted-foreground">The new server is checked first; nothing is sent to it until you start.</p>
        {target && <StatusMessage ok={!policy.blocked} text={policy.text} />}
      </div>
      {target && !policy.blocked && (
        <>
          <div className="space-y-2">
            <Label htmlFor="pen-move-handle">Its handle at the new server</Label>
            <Input id="pen-move-handle" value={handle} disabled={running} onChange={(e) => setHandle(e.target.value)} aria-describedby="pen-move-handle-hint" />
            <p id="pen-move-handle-hint" className="text-xs text-muted-foreground">
              {target.handleDomains.length ? `Must end with ${target.handleDomains.join(' or ')}. ` : ''}Its identity stays the same; only the handle changes.
            </p>
          </div>
          {!penPhrase && (
            <div className="space-y-2 rounded-md border p-4">
              <h3 className="text-sm font-semibold">{session.handle}&apos;s 12 words</h3>
              <p className="text-sm text-muted-foreground">They sign every step of the move on this device. Neither server has to agree, and neither sees them.</p>
              <PenWords penDid={entry.did} id="move-pen-words" onReady={(p) => void acceptWords(p)} />
            </div>
          )}
          <Acknowledge id="pen-move-ack" text={PEN_MOVE_ACK} checked={ack} onChange={setAck} disabled={running} />
          <p className="text-sm text-muted-foreground">Keep this page open until it says Done.</p>
          <Button type="button" onClick={start} disabled={!canStart}>{running ? 'Moving…' : `Move ${session.handle}`}</Button>
        </>
      )}
      {(running || result) && step !== null && <StepList steps={PEN_MOVE_STEPS} current={step} failed={!!result && !result.ok} done={!!result?.ok} />}
      {result?.ok && <StepList steps={PEN_MOVE_STEPS} current={null} failed={false} done />}
      {result && <StatusMessage ok={result.ok} text={result.text} />}
    </div>
  );
}

/** End the pen name for good: its words, a backup offer, two confirmations. */
export function EndPenName({ scope, entry, session, plcUrl, onEnded }: {
  /** Which list of pen names this browser keeps it in. */
  scope: string;
  entry: PenNameEntry;
  session: PenSession;
  plcUrl: string;
  onEnded: (text: string) => void;
}) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<EndStep | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);

  async function acceptWords(p: string) {
    setProblem(null);
    try { await assertPenWords(plcUrl, entry.did, p); setPhrase(p); } catch (e) { setProblem((e as Error).message); }
  }

  async function end() {
    if (!phrase) return;
    setRunning(true); setProblem(null);
    try {
      const { leftovers } = await endPenName({ scope, entry, phrase, plcUrl, onStep: setStep });
      onEnded(leftovers.length
        ? `${session.handle} has ended: it is retired in the public directory and its account here is deleted. A switched-off copy may remain at ${leftovers.map(host).join(', ')}; nobody can sign in to it.`
        : `${session.handle} has ended: its account and files are deleted and it is retired in the public directory.`);
    } catch (e) {
      const reason = (e as Error).message;
      setProblem(step === 'tombstone'
        ? `${reason}. Its account is deleted, but it is not yet retired in the public directory. Try again with its 12 words.`
        : `${reason}. ${step === 'check' || step === null ? 'Nothing was changed.' : 'Some copies may already be deleted; try again.'}`);
    } finally { setRunning(false); }
  }

  const canEnd = !!phrase && ack && typed.trim().toLowerCase() === session.handle.toLowerCase() && !running;

  return (
    <div className="space-y-4">
      <div className="text-sm"><p>{PEN_END.summary}</p><WhatIsThis term="end-pen-name" className="mt-1" /></div>
      <ChoiceExplainer text={PEN_END} />
      <div className="space-y-2">
        <Button type="button" variant="outline" disabled={running} onClick={async () => {
          try {
            saveFile(await downloadBackup(entry.home.url, entry.did), `${fileSafe(session.handle)}-backup.car`);
            setBackup('Backup saved.');
          } catch (e) { setBackup((e as Error).message); }
        }}>Download a backup first</Button>
        {backup && <p className="text-sm text-muted-foreground" role="status">{backup}</p>}
      </div>
      {!phrase ? (
        <div className="space-y-2 rounded-md border p-4">
          <h3 className="text-sm font-semibold">{session.handle}&apos;s 12 words</h3>
          <p className="text-sm text-muted-foreground">Only they can end it. Type them (or unlock them with this device&apos;s passkey), even if you signed in with them earlier.</p>
          <PenWords penDid={entry.did} id="end-pen-words" onReady={(p) => void acceptWords(p)} />
        </div>
      ) : (
        <Note>The 12 words check out: they control {session.handle}.</Note>
      )}
      <Acknowledge id="pen-end-ack" text={penEndAck(session.handle)} checked={ack} onChange={setAck} disabled={running} />
      <div className="space-y-2">
        <Label htmlFor="pen-end-type">Type {session.handle} to confirm</Label>
        <Input id="pen-end-type" autoComplete="off" spellCheck={false} value={typed} disabled={running} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <Button type="button" variant="destructive" onClick={end} disabled={!canEnd}>{running ? 'Ending…' : `End ${session.handle} for good`}</Button>
      {(running || problem) && <StepList steps={END_STEPS} current={step} failed={!!problem} done={false} />}
      {problem && <StatusMessage ok={false} text={problem} />}
    </div>
  );
}
