'use client';

import { useState } from 'react';
import { VenetianMask } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Note, Section, StatusMessage } from '@/components/account/explain';
import {
  forgetPenSession, savePenName, serverFacts, signInPenName,
  type PenHome, type PenNameEntry, type PenSession,
} from '@/lib/pen-names/pen-names';
import { PEN_NAMES } from '@/lib/copy/glossary';
import { PenWords } from './pen-parts';

const host = (url: string) => url.replace(/^https?:\/\//, '');

/**
 * The pen names this browser knows, and signing in as one: with its 12 words
 * or this device's passkey for it, into a session of its own.
 */
export function UseSection({ scope, list, thisServer, session, onSignedIn, onForget }: {
  /** Which list of pen names this browser keeps (the account page, or the signed-out pages). */
  scope: string;
  list: PenNameEntry[];
  thisServer: PenHome;
  session: PenSession | null;
  onSignedIn: (session: PenSession, phrase: string) => void;
  onForget: (did: string) => void;
}) {
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [otherUrl, setOtherUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function signIn(home: PenHome, phrase: string, expectDid?: string) {
    setBusy(true); setMessage(null);
    try {
      const s = await signInPenName(home, phrase);
      if (expectDid && s.did !== expectDid) {
        forgetPenSession();
        throw new Error('These words belong to a different pen name.');
      }
      const known = list.find((e) => e.did === s.did);
      savePenName(scope, { ...(known ?? {}), did: s.did, handle: s.handle, home });
      setSigningIn(null); setOther(false);
      onSignedIn(s, phrase);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  }

  async function signInElsewhere(phrase: string) {
    setBusy(true); setMessage(null);
    let home: PenHome = thisServer;
    try {
      if (other && otherUrl.trim()) {
        const facts = await serverFacts(/^https?:\/\//.test(otherUrl.trim()) ? otherUrl.trim() : `https://${otherUrl.trim()}`);
        home = { url: facts.url, serviceDid: facts.serviceDid };
      }
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      setBusy(false);
      return;
    }
    setBusy(false);
    await signIn(home, phrase);
  }

  return (
    <Section id="use" title="Use a pen name" description="Sign in as a pen name in this tab. Its session is kept apart from yours: requests as the pen name never carry your own sign-in, and yours never carry its.">
      <Note>{PEN_NAMES.where}</Note>

      {list.length > 0 && (
        <ul className="space-y-3" aria-label="Pen names on this device">
          {list.map((e) => (
            <li key={e.did} className="space-y-3 rounded-md border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="flex items-center gap-2 font-semibold"><VenetianMask className="size-4 shrink-0" aria-hidden /><span className="truncate">{e.handle}</span></p>
                  <p className="text-muted-foreground">Lives at {host(e.home.url)}{session?.did === e.did ? ' · signed in in this tab' : ''}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {session?.did !== e.did && (
                    <Button type="button" size="sm" variant="outline" disabled={busy}
                      onClick={() => { setMessage(null); setSigningIn(signingIn === e.did ? null : e.did); }}>
                      Sign in as it
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setForgetting(forgetting === e.did ? null : e.did)}>Forget on this device</Button>
                </div>
              </div>
              {signingIn === e.did && (
                <PenWords penDid={e.did} id={`pen-words-${e.did}`} action={busy ? 'Signing in…' : 'Sign in'} onReady={(p) => void signIn(e.home, p, e.did)} />
              )}
              {forgetting === e.did && (
                <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
                  <p>This removes {e.handle} from this browser&apos;s list, with its passkey on this device if there is one. The pen name keeps working: sign in again with its 12 words from anywhere.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="destructive" onClick={() => { setForgetting(null); onForget(e.did); }}>Forget {e.handle} here</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForgetting(null)}>Keep it</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-md border p-4" open={list.length === 0 ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">Sign in with a pen name&apos;s 12 words{list.length ? ' (one not listed here)' : ''}</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={other} onChange={(ev) => setOther(ev.target.checked)} />
            It lives on another server
          </label>
          {other && (
            <div className="space-y-2">
              <Label htmlFor="pen-other-url">Address of its server</Label>
              <Input id="pen-other-url" placeholder="https://pds.example.com" value={otherUrl} onChange={(ev) => setOtherUrl(ev.target.value)} />
            </div>
          )}
          <PenWords id="pen-words-any" action={busy ? 'Signing in…' : 'Sign in'} onReady={(p) => void signInElsewhere(p)} />
        </div>
      </details>

      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </Section>
  );
}
