'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RevealBundleV2 } from '@open-federation/pseudonym';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Acknowledge, ChoiceExplainer, Note, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { ExistingPhrase } from '@/components/custody/phrase-inputs';
import { assertPhraseBelongs, type CustodyMode } from '@/lib/custody/custody';
import {
  assertPenWords, inPersonProof, makeProof, ownerSignerFromWords, proofLink, publishProof, type PenSession,
} from '@/lib/pen-names/pen-names';
import { PEN_PROOF, PEN_PUBLIC_PROOF_ACK } from '@/lib/copy/glossary';
import { fileSafe, PenWords, ShareLink } from './pen-parts';

/** Who signs the person's half, said before the proof is made. */
function ownerHalf(mode: CustodyMode | null): { text: string; possible: boolean } {
  if (mode === 'custodial') {
    return { possible: true, text: 'Your account is Custodial, so this server signs your half, with the key it holds for your account. Whoever checks the proof is told it was signed by your server’s key: it shows your account agreed, as far as this server can say, not that you signed it yourself.' };
  }
  if (mode === 'assisted' || mode === 'self') {
    return { possible: true, text: 'You hold your own keys, so you sign your half yourself, with your own 12 words (yours, not the pen name’s). This server cannot make that half. Whoever checks the proof is told it was signed by the person.' };
  }
  return { possible: false, text: 'This server does not control your identity (you signed in with an account from another server, or this is the administrator account), so it cannot sign your half here.' };
}

/** The person's own account, on the account page only. The signed-out pages have none. */
export interface ProofOwner { did: string; accessJwt: string; pdsUrl: string; mode: CustodyMode | null }

/**
 * Prove the pen name is the person's: a proof both sign, as a /verify link
 * and QR code (or a file, or public); and an in-person proof of a spoken word.
 * Without `owner` (the signed-out pages) only the in-person proof is offered:
 * the other one needs the person's own account.
 */
export function ProveSection({ session, owner, plcUrl, penPhrase, onPenPhrase }: {
  session: PenSession;
  owner: ProofOwner | null;
  plcUrl: string;
  penPhrase: string | null;
  onPenPhrase: (phrase: string) => void;
}) {
  const client = useQueryClient();
  const mode = owner?.mode ?? null;
  const ownerDid = owner?.did ?? '';
  const ownerAccessJwt = owner?.accessJwt ?? '';
  const ownerPdsUrl = owner?.pdsUrl ?? '';
  const half = ownerHalf(mode);
  const ownWords = mode === 'assisted' || mode === 'self';
  const [identityPhrase, setIdentityPhrase] = useState<string | null>(null);
  const [bundle, setBundle] = useState<RevealBundleV2 | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [publicAck, setPublicAck] = useState(false);
  const [published, setPublished] = useState(false);
  const [word, setWord] = useState('');
  const [presence, setPresence] = useState<{ word: string; link: string; valid: boolean } | null>(null);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  async function acceptPenWords(p: string) {
    setMessage(null);
    try { await assertPenWords(plcUrl, session.did, p); onPenPhrase(p); } catch (e) { setMessage({ ok: false, text: (e as Error).message }); }
  }

  async function acceptIdentityWords(p: string) {
    setMessage(null);
    try { await assertPhraseBelongs(ownerPdsUrl, ownerDid, p); setIdentityPhrase(p); } catch (e) { setMessage({ ok: false, text: (e as Error).message }); }
  }

  async function make() {
    if (!penPhrase) return;
    setBusy(true); setMessage(null); setPublished(false); setPublicAck(false);
    try {
      setBundle(await makeProof({
        ownerPdsUrl, plcUrl, penPhrase, penDid: session.did, ownerDid, ownerAccessJwt,
        ...(ownWords && identityPhrase ? { ownerSigner: ownerSignerFromWords(identityPhrase) } : {}),
      }));
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  async function publish() {
    if (!bundle) return;
    setBusy(true); setMessage(null);
    try {
      await publishProof({ ownerPdsUrl, bundle, ownerAccessJwt });
      setPublished(true);
      setMessage({ ok: true, text: `The proof is now in public, in the files of ${session.handle} and of your account.` });
      await client.invalidateQueries({ queryKey: ['pen-files', session.did] });
    } catch (e) { setMessage({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  async function signWord(e: React.FormEvent) {
    e.preventDefault();
    if (!penPhrase || !word.trim()) return;
    setBusy(true); setMessage(null);
    try {
      const out = await inPersonProof({ origin, plcUrl, penPhrase, penDid: session.did, word: word.trim() });
      setPresence({ word: word.trim(), ...out });
    } catch (err) { setMessage({ ok: false, text: (err as Error).message }); } finally { setBusy(false); }
  }

  const needPenWords = !penPhrase;
  const needIdentityWords = ownWords && !identityPhrase;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-sm"><p>{PEN_PROOF.summary}</p><WhatIsThis term="pen-proof" className="mt-1" /></div>
        <ChoiceExplainer text={PEN_PROOF} />
      </div>

      {needPenWords && (
        <div className="space-y-2 rounded-md border p-4">
          <h3 className="text-sm font-semibold">First, {session.handle}&apos;s 12 words</h3>
          <p className="text-sm text-muted-foreground">They sign on this device and stay in this page&apos;s memory until you sign out of the pen name or leave the page.</p>
          <PenWords penDid={session.did} id="prove-pen-words" onReady={(p) => void acceptPenWords(p)} />
        </div>
      )}

      {!owner && (
        <section aria-labelledby="proof-title" className="space-y-3">
          <h3 id="proof-title" className="text-base font-semibold">A proof that names your account</h3>
          <Note>
            This proof is signed by your own account as well, so it is made on your account&apos;s Pen names page, signed in to both.
            Making it there tells this server that the two belong together, even before you show the proof to anyone, so do it only once you have decided to reveal.
            The in-person proof below names no account and can be made here.
          </Note>
        </section>
      )}

      {owner && <section aria-labelledby="proof-title" className="space-y-3">
        <h3 id="proof-title" className="text-base font-semibold">A proof to show</h3>
        <Note>{half.text}</Note>
        {half.possible && needIdentityWords && (
          <div className="space-y-2 rounded-md border p-4">
            <h4 className="text-sm font-semibold">Your own 12 words, to sign your half</h4>
            <ExistingPhrase did={ownerDid} onReady={(p) => void acceptIdentityWords(p)} />
          </div>
        )}
        {half.possible && !bundle && (
          <Button type="button" onClick={make} disabled={busy || needPenWords || needIdentityWords}>{busy ? 'Signing…' : 'Make the proof'}</Button>
        )}
        {bundle && (
          <>
            <ShareLink
              link={proofLink(origin, bundle)}
              label={`Anyone who opens this link sees that ${session.handle} belongs to your account, checked on their own device.`}
              qrLabel={`QR code: proof that ${session.handle} is yours`}
              file={{ name: `${fileSafe(session.handle)}-proof.json`, json: bundle }}
            />
            <p className="text-sm text-muted-foreground">
              The file is the same proof for the command line: <code className="text-xs">ofc pseudonym verify file.json --online</code>. Nothing is public until you hand the link or file to someone, or publish it below.
            </p>
            <details className="rounded-md border p-4">
              <summary className="cursor-pointer text-sm font-medium">Publish it, for anyone to find</summary>
              <div className="mt-3 space-y-3">
                <p className="text-sm">This writes the proof into the public files of both {session.handle} and your account. Anyone reading either account sees it.</p>
                <Acknowledge id="proof-public-ack" text={PEN_PUBLIC_PROOF_ACK} checked={publicAck} onChange={setPublicAck} disabled={published} />
                <Button type="button" variant="destructive" onClick={publish} disabled={!publicAck || busy || published}>
                  {published ? 'Published' : busy ? 'Publishing…' : 'Publish the proof'}
                </Button>
              </div>
            </details>
            <Button type="button" variant="ghost" onClick={() => { setBundle(null); setPublished(false); }}>Delete this proof from the page</Button>
          </>
        )}
      </section>}

      <section aria-labelledby="presence-title" className="space-y-3 border-t pt-6">
        <h3 id="presence-title" className="text-base font-semibold">In person</h3>
        <WhatIsThis term="in-person-proof" label="What is an in-person proof?" />
        <p className="text-sm text-muted-foreground">
          Someone in front of you says a word. The pen name&apos;s 12 words sign it here, and they check it on their own phone. It shows you hold {session.handle}&apos;s words; it does not name your account.
        </p>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={signWord}>
          <div className="flex-1 space-y-2">
            <Label htmlFor="presence-word">The word they said</Label>
            <Input id="presence-word" autoComplete="off" value={word} onChange={(e) => { setWord(e.target.value); setPresence(null); }} />
          </div>
          <Button type="submit" disabled={busy || needPenWords || !word.trim()}>Sign this word</Button>
        </form>
        {presence && (
          <>
            <StatusMessage ok={presence.valid} text={presence.valid
              ? `Signed. Checked here against the public directory: VALID for “${presence.word}”.`
              : 'The signature did not check out against the public directory.'} />
            <ShareLink link={presence.link} label="Let them scan this, or open the link on their phone. Their phone checks it against the public directory." qrLabel={`QR code: ${session.handle} signed the word ${presence.word}`} />
          </>
        )}
      </section>

      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </div>
  );
}
