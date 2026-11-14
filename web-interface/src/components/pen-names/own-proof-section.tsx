'use client';

import { useEffect, useState } from 'react';
import type { RevealBundleV2 } from '@open-federation/pseudonym';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Acknowledge, Note, StatusMessage } from '@/components/account/explain';
import { TypedPhrase } from '@/components/custody/phrase-inputs';
import { checkOwnAccount, makeOwnProof, proofLink, suggestOwner, type PenSession } from '@/lib/pen-names/pen-names';
import { CUSTODY, PEN_SHOW_PROOF_ACK } from '@/lib/copy/glossary';
import { fileSafe, ShareLink } from './pen-parts';

/**
 * The proof that names the person's account, on the signed-out pages. Only
 * for an owner who holds their own keys (Assisted or Self): their own 12
 * words sign their half here, so no session of their account is used or
 * sent. Before anything is signed: the pen name's sealed note must name the
 * account, and the words must hold the key the account publishes. The words
 * are typed, never stored, and cleared once used.
 */
export function OwnProofSection({ session, plcUrl, penPhrase }: { session: PenSession; plcUrl: string; penPhrase: string | null }) {
  const [open, setOpen] = useState(false);
  const [ownerDid, setOwnerDid] = useState('');
  const [suggested, setSuggested] = useState<string | null>(null);
  const [checkedDid, setCheckedDid] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  /** Remounts the words box, which clears what was typed. */
  const [attempt, setAttempt] = useState(0);
  const [bundle, setBundle] = useState<RevealBundleV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // Offer the account this browser already knows, once the pen name's words can open its sealed note.
  useEffect(() => {
    if (!open || !penPhrase || ownerDid) return;
    let live = true;
    void suggestOwner(plcUrl, session.did, penPhrase).then((did) => {
      if (live && did) { setSuggested(did); setOwnerDid((cur) => cur || did); }
    });
    return () => { live = false; };
    // Only when the section opens or the pen name's words arrive; typing must not trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, penPhrase, plcUrl, session.did]);

  async function checkAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!penPhrase) return;
    setBusy(true); setMessage(null); setCheckedDid(null);
    try {
      await checkOwnAccount({ plcUrl, penDid: session.did, penPhrase, ownerDid });
      setCheckedDid(ownerDid.trim());
    } catch (err) { setMessage({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  }

  async function sign(identityPhrase: string) {
    if (!penPhrase || !checkedDid) return;
    setBusy(true); setMessage(null);
    try {
      setBundle(await makeOwnProof({ plcUrl, penPhrase, penDid: session.did, ownerDid: checkedDid, identityPhrase }));
    } catch (err) { setMessage({ ok: false, text: (err as Error).message }); } finally {
      setAttempt((n) => n + 1);
      setBusy(false);
    }
  }

  function startOver() {
    setBundle(null); setAck(false); setCheckedDid(null); setMessage(null);
  }

  return (
    <section aria-labelledby="own-proof-title" className="space-y-3">
      <h3 id="own-proof-title" className="text-base font-semibold">A proof that names your account</h3>
      <Note>
        If your account is {CUSTODY.assisted.title} or {CUSTODY.self.title}, you sign your half yourself, with your own 12 words, so you can make this proof here:
        this server is not asked and not told. If your account is {CUSTODY.custodial.title}, its server signs your half, so make it on your account&apos;s Pen names page, signed in.
      </Note>
      <details className="rounded-md border p-4" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm font-medium">I have decided to reveal that a pen name is mine</summary>
        <div className="mt-3 space-y-4">
          {!penPhrase && <p className="text-sm text-muted-foreground">First type {session.handle}&apos;s 12 words above: they open the sealed note in its public entry, and sign the pen name&apos;s half.</p>}

          {penPhrase && !bundle && (
            <>
              <form className="space-y-2" onSubmit={checkAccount}>
                <Label htmlFor="own-proof-did">Your account (its DID)</Label>
                <Input id="own-proof-did" autoComplete="off" spellCheck={false} className="font-mono text-xs" placeholder="did:plc:…" value={ownerDid}
                  onChange={(e) => { setOwnerDid(e.target.value); setCheckedDid(null); }} aria-describedby="own-proof-did-hint" />
                <p id="own-proof-did-hint" className="text-xs text-muted-foreground">
                  {suggested && suggested === ownerDid.trim()
                    ? 'Filled in from what this browser already knows, and it matches the sealed note in the pen name’s entry.'
                    : 'It starts with did:plc: and is on your account page and in your pass file. Only the public directory is asked about it; this server is not.'}
                </p>
                <Button type="submit" variant="outline" disabled={busy || !ownerDid.trim() || checkedDid === ownerDid.trim()}>
                  {busy && !checkedDid ? 'Checking…' : 'Check this account'}
                </Button>
              </form>

              {checkedDid && (
                <div className="space-y-4">
                  <StatusMessage ok text={`The sealed note in ${session.handle}’s public entry names this account, and the account has a key of its own.`} />
                  <Acknowledge id="own-proof-ack" text={PEN_SHOW_PROOF_ACK} checked={ack} onChange={setAck} disabled={busy} />
                  {ack && (
                    <div className="space-y-2 rounded-md border p-4">
                      <h4 className="text-sm font-semibold">Your own 12 words, to sign your half</h4>
                      <p className="text-sm text-muted-foreground">
                        Your account&apos;s words, not the pen name&apos;s. They are checked against your account&apos;s key in the public directory before anything is signed,
                        and are cleared from this page as soon as they are used. They are never stored or sent.
                      </p>
                      <TypedPhrase key={attempt} id="own-proof-words" label="Your own 12 words" action={busy ? 'Signing…' : 'Check them and make the proof'} onReady={(p) => { if (!busy) void sign(p); }} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {bundle && (
            <>
              <StatusMessage ok text="Made and checked here against the public directory: VALID, signed by you." />
              <ShareLink
                link={proofLink(origin, bundle)}
                label={`Anyone who opens this link sees that ${session.handle} belongs to your account, signed by you, checked on their own device.`}
                qrLabel={`QR code: proof that ${session.handle} is yours`}
                file={{ name: `${fileSafe(session.handle)}-proof.json`, json: bundle }}
              />
              <p className="text-sm text-muted-foreground">
                The file is the same proof for the command line: <code className="text-xs">ofc pseudonym verify file.json --online</code>. Nothing is public until you hand the link or file to someone.
              </p>
              <Note>
                Publishing the proof into both accounts&apos; public files needs both accounts signed in, so it cannot be done here. If you want it public, publish it from your account&apos;s Pen names page.
              </Note>
              <Button type="button" variant="ghost" onClick={startOver}>Delete this proof from the page</Button>
            </>
          )}

          {message && <StatusMessage ok={message.ok} text={message.text} />}
        </div>
      </details>
    </section>
  );
}
