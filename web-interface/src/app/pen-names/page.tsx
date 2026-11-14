'use client';

/**
 * Use a pen name without signing in to an account (outside the dashboard,
 * like /verify): sign in with its 12 words or this device's passkey, then
 * publish, files and backup, the in-person proof, move and end. The pen
 * name's session is its own, in this tab; the person's session is never
 * loaded or sent from here.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusMessage, WhatIsThis } from '@/components/account/explain';
import { SignedOutFrame } from '@/components/pen-names/signed-out-frame';
import { UseSection } from '@/components/pen-names/use-section';
import { PenSessionPanel } from '@/components/pen-names/pen-session-panel';
import {
  forgetPenName, loadPenNames, loadPenSession, serverFacts, signOutPenName, SIGNED_OUT_SCOPE,
  type PenNameEntry, type PenSession,
} from '@/lib/pen-names/pen-names';
import { THIS_PDS } from '@/lib/this-pds';
import { serverProblem } from '@/lib/pen-names/service-pin';

export default function UsePenNamePage() {
  const server = useQuery({ queryKey: ['pen-server', THIS_PDS], queryFn: () => serverFacts(THIS_PDS) });
  const [list, setList] = useState<PenNameEntry[]>([]);
  const [session, setSession] = useState<PenSession | null>(null);
  /** The signed-in pen name's 12 words: in this page's memory only, never stored. */
  const [penPhrase, setPenPhrase] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(() => {
    setList(loadPenNames(SIGNED_OUT_SCOPE));
    setSession(loadPenSession());
  }, []);
  // Browser storage exists only after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  const facts = server.data;
  const entry = session ? (list.find((e) => e.did === session.did) ?? { did: session.did, handle: session.handle, home: session.home }) : null;

  return (
    <SignedOutFrame current="use">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Use a pen name</h1>
        <div className="text-muted-foreground">Sign in as a pen name with its 12 words, without any account. <WhatIsThis term="pen-name" className="mt-1" /></div>
      </div>

      {server.isLoading && <Skeleton className="h-40 rounded-xl" />}
      {server.error && <StatusMessage ok={false} text={serverProblem(server.error, 'Could not reach this server')} />}

      {facts && (
        <>
          <UseSection
            scope={SIGNED_OUT_SCOPE}
            list={list}
            thisServer={{ url: facts.url, serviceDid: facts.serviceDid }}
            session={session}
            onSignedIn={(s, phrase) => { setMessage(null); setPenPhrase(phrase); reload(); setSession(s); }}
            onForget={(did) => {
              if (session?.did === did) setPenPhrase(null);
              setList(forgetPenName(SIGNED_OUT_SCOPE, did));
              setSession(loadPenSession());
            }}
          />

          {message && <StatusMessage ok={message.ok} text={message.text} />}

          {session && entry && (
            <PenSessionPanel
              scope={SIGNED_OUT_SCOPE}
              facts={facts}
              session={session}
              entry={entry}
              penPhrase={penPhrase}
              onPenPhrase={setPenPhrase}
              onSignOut={async () => { await signOutPenName(); setPenPhrase(null); setSession(null); }}
              onMoved={() => reload()}
              onEnded={(text) => { setPenPhrase(null); reload(); setMessage({ ok: true, text }); }}
              owner={null}
              tabs={['publish', 'files', 'prove', 'move', 'end']}
              note="Everything in this box acts as the pen name, with its own session. No account's sign-in is used or sent."
            />
          )}
        </>
      )}
    </SignedOutFrame>
  );
}
