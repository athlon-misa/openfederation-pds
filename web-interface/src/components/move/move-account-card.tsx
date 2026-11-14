'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ACCOUNT_POINT_OF_NO_RETURN, ACCOUNT_STEPS, moveAccount, type AccountStep } from '@/lib/move/account-move';
import { describeTarget, type TargetInfo } from '@/lib/move/xrpc';
import { MOVE_ACK, MOVING, type CustodyMode } from '@/lib/copy/glossary';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { StepList, policyNote } from './move-parts';
import { THIS_PDS } from '@/lib/this-pds';

export function MoveAccountCard({ did, handle, email, mode }: { did: string; handle: string; email: string; mode?: CustodyMode }) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [newHandle, setNewHandle] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const [step, setStep] = useState<AccountStep | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const codeResolver = useRef<((c: string) => void) | null>(null);
  const reached = useRef<Set<AccountStep>>(new Set());

  const note = policyNote(target?.migration?.accounts, 'accounts', target);

  async function check() {
    setChecking(true); setResult(null); setTarget(null);
    try {
      const t = await describeTarget(url);
      setTarget(t);
      if (!newHandle && t.handleDomains[0]) setNewHandle(`${handle.split('.')[0]}${t.handleDomains[0]}`);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally { setChecking(false); }
  }

  async function start() {
    if (!target) return;
    setRunning(true); setResult(null); reached.current.clear();
    try {
      const done = await moveAccount({
        oldPdsUrl: THIS_PDS, target, did, identifier: handle, email, password, newHandle: newHandle.trim(),
        inviteCode: inviteCode.trim() || undefined,
        onStep: (s) => { reached.current.add(s); setStep(s); },
        readCode: () => new Promise<string>((resolve) => { setNeedCode(true); codeResolver.current = resolve; }),
      });
      setStep(null);
      setResult({ ok: true, message: `Done. Your account now lives at ${done.newPdsUrl}. Sign in there from now on; the copy here is switched off and can be deleted.` });
    } catch (e) {
      const changed = reached.current.has(ACCOUNT_POINT_OF_NO_RETURN);
      setResult({
        ok: false,
        message: changed
          ? `${(e as Error).message}. Your identity already points at the new server: finish there (sign in at ${target.url} and switch the account on).`
          : `${(e as Error).message}. Nothing changed: your account still lives here. The new server may keep an unused, switched-off copy.`,
      });
    } finally { setRunning(false); setNeedCode(false); setPassword(''); }
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    codeResolver.current?.(code.trim());
    codeResolver.current = null; setNeedCode(false); setCode('');
  }

  // A Self account's identity has no key on this server, so this server cannot sign the move (ADR-003).
  if (mode === 'self') {
    return (
      <Section title="Moving a Self account">
        <ChoiceExplainer text={MOVING} />
        <Note>
          Your account is Self: only your 12 words can point your identity at another server, and this dashboard cannot do that yet.
          An app built on the OpenFederation SDK can do it with your 12 words, even without this server&apos;s help.
          If you would rather move from here, switch to Assisted first in Identity &amp; keys.
        </Note>
      </Section>
    );
  }

  const canStart = !!target && !note.blocked && !!newHandle.trim() && !!password && (!note.needsInvite || !!inviteCode.trim()) && ack && !running;

  return (
    <>
      <Section title="Before you move" description={<>{MOVING.summary} <WhatIsThis term="moving" className="mt-1" /></>}>
        <ChoiceExplainer text={MOVING} />
        {mode === 'assisted' && (
          <Note>Your account is Assisted, so this server signs the move with its backup key and emails you that it did. That email is expected; do not cancel the change.</Note>
        )}
      </Section>

      <Section title="Where to" description="The new server is checked first; nothing is sent to it until you start.">
        <div className="space-y-2">
          <Label htmlFor="move-url">Address of the new server</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="move-url" placeholder="https://pds.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setTarget(null); }} disabled={running} />
            <Button type="button" variant="outline" onClick={check} disabled={!url.trim() || checking || running}>{checking ? 'Checking…' : 'Check this server'}</Button>
          </div>
          {target && <StatusMessage ok={!note.blocked} text={note.text} />}
        </div>

        {target && !note.blocked && (
          <>
            <div className="space-y-2">
              <Label htmlFor="move-handle">Your handle at the new server</Label>
              <Input id="move-handle" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} disabled={running} aria-describedby="move-handle-hint" />
              <p id="move-handle-hint" className="text-xs text-muted-foreground">
                {target.handleDomains.length > 0 ? `Must end with ${target.handleDomains.join(' or ')}. ` : ''}Your identity stays the same; only the handle changes.
              </p>
            </div>
            {note.needsInvite && (
              <div className="space-y-2">
                <Label htmlFor="move-invite">Invite code from the new server</Label>
                <Input id="move-invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} disabled={running} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="move-password">Your password</Label>
              <Input id="move-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={running} aria-describedby="move-password-hint" />
              <p id="move-password-hint" className="text-xs text-muted-foreground">Used here to confirm the move, and as your password at the new server.</p>
            </div>
            <Acknowledge id="move-ack" text={MOVE_ACK} checked={ack} onChange={setAck} disabled={running} />
            <p className="text-sm text-muted-foreground">You will get an email with a code during the move. Keep this page open until it says Done.</p>
            <Button type="button" onClick={start} disabled={!canStart}>{running ? 'Moving…' : 'Move my account'}</Button>
          </>
        )}

        {(running || result) && <StepList steps={ACCOUNT_STEPS} current={step} failed={!!result && !result.ok} done={!!result?.ok} />}

        {needCode && (
          <form onSubmit={submitCode} className="space-y-2 rounded-md border p-3">
            <Label htmlFor="move-code">We emailed you a code to confirm the move. Enter it here.</Label>
            <div className="flex gap-2">
              <Input id="move-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" />
              <Button type="submit" disabled={!code.trim()}>Confirm</Button>
            </div>
          </form>
        )}

        {result && <StatusMessage ok={result.ok} text={result.message} />}
      </Section>
    </>
  );
}
