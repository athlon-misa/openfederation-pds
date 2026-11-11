'use client';

import { useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ACCOUNT_POINT_OF_NO_RETURN, ACCOUNT_STEPS, moveAccount, type AccountStep } from '@/lib/move/account-move';
import { describeTarget, type TargetInfo } from '@/lib/move/xrpc';
import { StepList, policyNote } from './move-parts';

const THIS_PDS = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

export function MoveAccountCard({ did, handle, email }: { did: string; handle: string; email: string }) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [newHandle, setNewHandle] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [password, setPassword] = useState('');
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
          ? `${(e as Error).message}. Your DID already points at the new server: finish there (sign in at ${target.url} and activate the account).`
          : `${(e as Error).message}. Nothing changed: your account still lives here. The new server may keep an unused, switched-off copy.`,
      });
    } finally { setRunning(false); setNeedCode(false); setPassword(''); }
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    codeResolver.current?.(code.trim());
    codeResolver.current = null; setNeedCode(false); setCode('');
  }

  const canStart = !!target && !note.blocked && !!newHandle.trim() && !!password && (!note.needsInvite || !!inviteCode.trim()) && !running;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Move account</CardTitle>
        <CardDescription>
          Move your account, with everything in it, to another server. Your identity (DID) stays the same. Nothing changes here until the new server holds an exact copy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="move-url">New server</Label>
          <div className="flex gap-2">
            <Input id="move-url" placeholder="https://pds.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setTarget(null); }} disabled={running} />
            <Button type="button" variant="outline" onClick={check} disabled={!url.trim() || checking || running}>{checking ? 'Checking...' : 'Check'}</Button>
          </div>
          {target && <p className={`text-sm ${note.blocked ? 'text-destructive' : 'text-muted-foreground'}`}>{note.text}</p>}
        </div>

        {target && !note.blocked && (
          <>
            <div className="space-y-2">
              <Label htmlFor="move-handle">Handle at the new server</Label>
              <Input id="move-handle" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} disabled={running} />
              {target.handleDomains.length > 0 && <p className="text-xs text-muted-foreground">Must end with {target.handleDomains.join(' or ')}</p>}
            </div>
            {note.needsInvite && (
              <div className="space-y-2">
                <Label htmlFor="move-invite">Invite code from the new server</Label>
                <Input id="move-invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} disabled={running} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="move-password">Your password</Label>
              <Input id="move-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={running} />
              <p className="text-xs text-muted-foreground">Used here to sign the move, and as your password at the new server.</p>
            </div>
            <Button type="button" onClick={start} disabled={!canStart}>{running ? 'Moving...' : 'Move my account'}</Button>
          </>
        )}

        {(running || result) && <StepList steps={ACCOUNT_STEPS} current={step} failed={!!result && !result.ok} done={!!result?.ok} />}

        {needCode && (
          <form onSubmit={submitCode} className="space-y-2 rounded-md border p-3">
            <Label htmlFor="move-code">We emailed you a code to confirm the move</Label>
            <div className="flex gap-2">
              <Input id="move-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <Button type="submit" disabled={!code.trim()}>Confirm</Button>
            </div>
          </form>
        )}

        {result && <p className={`text-sm ${result.ok ? 'text-green-700' : 'text-destructive'}`} role="status">{result.message}</p>}
      </CardContent>
    </Card>
  );
}
