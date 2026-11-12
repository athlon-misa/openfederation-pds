'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { xrpc } from '@/lib/api-client';

/**
 * The operator verifies that a person is who they say (before an assisted
 * account recovers with a new phrase, or a vault share is released): the
 * server emails the account a code, the person gives it back to the operator.
 * The verification lasts 30 minutes.
 */
export function VerifyIdentityDialog({ target, onClose }: { target: { did: string; handle: string } | null; onClose: () => void }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => { setSent(false); setCode(''); onClose(); };

  async function send() {
    if (!target) return;
    setBusy(true);
    const res = await xrpc('net.openfederation.admin.createVerificationChallenge', { body: { did: target.did } });
    setBusy(false);
    if (res.ok) { setSent(true); toast.success('Code sent to the account\'s email'); }
    else toast.error(res.message);
  }

  async function verify() {
    if (!target) return;
    setBusy(true);
    const res = await xrpc<{ verified: boolean }>('net.openfederation.admin.verifyChallenge', { body: { did: target.did, nonce: code.trim() } });
    setBusy(false);
    if (res.ok && res.data.verified) { toast.success(`@${target.handle} is verified for the next 30 minutes`); close(); }
    else toast.error(res.ok ? 'The code does not match' : res.message);
  }

  if (!target) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify identity of @{target.handle}</DialogTitle>
          <DialogDescription>
            Sends a one-time code to the account&apos;s email. Ask the person to give it back to you through a channel you trust. Once verified, for 30 minutes they can recover an assisted account with a new phrase or receive a vault share.
          </DialogDescription>
        </DialogHeader>
        {sent && (
          <div className="space-y-2">
            <Label htmlFor="verify-code">Code the person gave you</Label>
            <Input id="verify-code" autoComplete="off" className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Close</Button>
          {!sent
            ? <Button onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send code'}</Button>
            : <Button onClick={verify} disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Verify'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
