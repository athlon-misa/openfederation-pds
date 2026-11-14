'use client';

import { useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { COMMUNITY_POINT_OF_NO_RETURN, COMMUNITY_STEPS, moveCommunity, type CommunityStep } from '@/lib/move/community-move';
import { parsePrivateKey } from '@/lib/move/jwt';
import { describeTarget, type TargetInfo } from '@/lib/move/xrpc';
import { useAuthStore } from '@/store/auth-store';
import { StepList, policyNote } from './move-parts';
import { THIS_PDS } from '@/lib/this-pds';

export function MoveCommunityCard({ communityDid, communityHandle }: { communityDid: string; communityHandle: string }) {
  const ownerDid = useAuthStore((s) => s.did);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [newHandle, setNewHandle] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [keyText, setKeyText] = useState('');
  const [step, setStep] = useState<CommunityStep | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const reached = useRef<Set<CommunityStep>>(new Set());

  const note = policyNote(target?.migration?.communities, 'communities', target);

  async function check() {
    setChecking(true); setResult(null); setTarget(null);
    try {
      const t = await describeTarget(url);
      setTarget(t);
      if (!newHandle && t.handleDomains[0]) setNewHandle(`${communityHandle.split('.')[0]}${t.handleDomains[0]}`);
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally { setChecking(false); }
  }

  async function start() {
    if (!target || !ownerDid || !accessToken) return;
    let rotationKey: Uint8Array;
    try { rotationKey = parsePrivateKey(keyText); } catch (e) { setResult({ ok: false, message: (e as Error).message }); return; }
    setRunning(true); setResult(null); reached.current.clear();
    try {
      const done = await moveCommunity({
        oldPdsUrl: THIS_PDS, target, did: communityDid, ownerDid, ownerAccessJwt: accessToken, rotationKey,
        newHandle: newHandle.trim(), inviteCode: inviteCode.trim() || undefined,
        onStep: (s) => { reached.current.add(s); setStep(s); },
      });
      setStep(null);
      const keys = done.missingAttestationKeys ? ` ${done.missingAttestationKeys} private attestation key(s) did not arrive yet; activating again at the new server fetches them.` : '';
      setResult({ ok: true, message: `Done. The community now lives at ${done.newPdsUrl}; the copy here is read-only.${keys}` });
    } catch (e) {
      const changed = reached.current.has(COMMUNITY_POINT_OF_NO_RETURN);
      setResult({
        ok: false,
        message: changed
          ? `${(e as Error).message}. The community DID may already point at the new server: finish there (activate the community at ${target.url}).`
          : `${(e as Error).message}. Nothing changed: the community still lives here. The new server may keep an unused copy.`,
      });
    } finally { setRunning(false); rotationKey.fill(0); setKeyText(''); }
  }

  const canStart = !!target && !note.blocked && !!newHandle.trim() && !!keyText.trim() && (!note.needsInvite || !!inviteCode.trim()) && !running;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Move community</CardTitle>
        <CardDescription>
          Move this community, with its members, records and files, to another server. Its DID stays the same. You need the primary rotation key you saved when you created the community; it is used only in this browser and never sent anywhere.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cmove-url">New server</Label>
          <div className="flex gap-2">
            <Input id="cmove-url" placeholder="https://pds.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setTarget(null); }} disabled={running} />
            <Button type="button" variant="outline" onClick={check} disabled={!url.trim() || checking || running}>{checking ? 'Checking...' : 'Check'}</Button>
          </div>
          {target && <p className={`text-sm ${note.blocked ? 'text-destructive' : 'text-muted-foreground'}`}>{note.text}</p>}
        </div>

        {target && !note.blocked && (
          <>
            <div className="space-y-2">
              <Label htmlFor="cmove-handle">Handle at the new server</Label>
              <Input id="cmove-handle" value={newHandle} onChange={(e) => setNewHandle(e.target.value)} disabled={running} />
            </div>
            {note.needsInvite && (
              <div className="space-y-2">
                <Label htmlFor="cmove-invite">Invite code from the new server</Label>
                <Input id="cmove-invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} disabled={running} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="cmove-key">Primary rotation key</Label>
              <Textarea id="cmove-key" value={keyText} onChange={(e) => setKeyText(e.target.value)} disabled={running}
                autoComplete="off" spellCheck={false} className="font-mono text-xs" placeholder="base64, as shown when the community was created" />
            </div>
            <Button type="button" onClick={start} disabled={!canStart}>{running ? 'Moving...' : 'Move community'}</Button>
          </>
        )}

        {(running || result) && <StepList steps={COMMUNITY_STEPS} current={step} failed={!!result && !result.ok} done={!!result?.ok} />}
        {result && <p className={`text-sm ${result.ok ? 'text-green-700' : 'text-destructive'}`} role="status">{result.message}</p>}
      </CardContent>
    </Card>
  );
}
