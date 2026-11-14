'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogOut, VenetianMask } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { PassesSection } from '@/components/pen-names/passes-section';
import { CreateSection } from '@/components/pen-names/create-section';
import { UseSection } from '@/components/pen-names/use-section';
import { PenFiles, PublishClaim } from '@/components/pen-names/publish-files';
import { ProveSection } from '@/components/pen-names/prove-section';
import { EndPenName, MovePenName } from '@/components/pen-names/move-end';
import { PenPasskeyOffer } from '@/components/pen-names/pen-parts';
import { identityPolicy } from '@/lib/custody/custody';
import {
  forgetPenName, loadPasses, loadPenNames, loadPenPasskey, loadPenSession, serverFacts, signInPenName, signOutPenName,
  type PenNameEntry, type PenSession, type ServerFacts,
} from '@/lib/pen-names/pen-names';
import { PEN_NAMES } from '@/lib/copy/glossary';
import { THIS_PDS } from '@/hooks/use-identity';

export default function PenNamesPage() {
  const policy = useQuery({ queryKey: ['identity-policy'], queryFn: () => identityPolicy(THIS_PDS) });
  const enabled = policy.data?.pseudonymsEnabled;
  return (
    <div className="space-y-6">
      <PageHeader title="Pen names" description="Publishing under another name, without your name on it." />
      <Section title="What a pen name is" description={<WhatIsThis term="pen-name" />}>
        <ChoiceExplainer text={PEN_NAMES} />
      </Section>
      <Section title="On this server">
        <p className="text-sm font-medium" role="status">
          {policy.isLoading ? 'Checking…' : enabled === undefined ? 'This server did not say whether it allows pen names.'
            : enabled ? 'This server allows new pen names.' : 'This server does not allow new pen names.'}
        </p>
        {enabled === false && (
          <Note>
            Pen names that already exist here keep working: you can still sign in as them, publish, prove they are yours, move them to another server and end them.
            Only creating new ones (and collecting passes for them) is switched off, by whoever runs this server.
          </Note>
        )}
        <p className="text-sm text-muted-foreground">
          Someone showed you a proof that a pen name belongs to a person? Open the link they gave you: it checks the proof on your own device, against the public directory, without signing in.
        </p>
      </Section>
      <AccountGate>{(ctx) => <PenNameScreens ctx={ctx} creationAllowed={enabled !== false} />}</AccountGate>
    </div>
  );
}

function PenNameScreens({ ctx, creationAllowed }: { ctx: AccountContext; creationAllowed: boolean }) {
  const { did: ownerDid, accessToken, mode } = ctx;
  const server = useQuery({ queryKey: ['pen-server', THIS_PDS], queryFn: () => serverFacts(THIS_PDS) });
  const [list, setList] = useState<PenNameEntry[]>([]);
  const [session, setSession] = useState<PenSession | null>(null);
  /** The signed-in pen name's 12 words: in this page's memory only, never stored. */
  const [penPhrase, setPenPhrase] = useState<string | null>(null);
  const [passesLeft, setPassesLeft] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(() => {
    setList(loadPenNames(ownerDid));
    setSession(loadPenSession());
    setPassesLeft(loadPasses(ownerDid).length);
  }, [ownerDid]);

  // Browser storage exists only after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  if (server.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (server.error || !server.data) {
    return <StatusMessage ok={false} text={`Could not read this server's settings: ${(server.error as Error | null)?.message ?? 'no answer'}`} />;
  }
  const facts: ServerFacts = server.data;
  const entry = session ? (list.find((e) => e.did === session.did) ?? { did: session.did, handle: session.handle, home: session.home }) : null;

  return (
    <>
      {creationAllowed && facts.pseudonymsEnabled && (
        <>
          <PassesSection pdsUrl={THIS_PDS} ownerDid={ownerDid} ownerAccessJwt={accessToken} left={passesLeft} onChange={reload} />
          <CreateSection
            server={facts}
            ownerDid={ownerDid}
            passesLeft={passesLeft}
            onCreated={reload}
            onUse={async (created, phrase) => {
              setMessage(null);
              try {
                await signInPenName(created.home, phrase);
                setPenPhrase(phrase);
                reload();
                document.getElementById('pen-session')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              } catch (e) { reload(); setMessage({ ok: false, text: (e as Error).message }); }
            }}
          />
        </>
      )}

      <UseSection
        ownerDid={ownerDid}
        list={list}
        thisServer={{ url: facts.url, serviceDid: facts.serviceDid }}
        session={session}
        onSignedIn={(s, phrase) => { setMessage(null); setPenPhrase(phrase); reload(); setSession(s); }}
        onForget={(did) => {
          if (session?.did === did) setPenPhrase(null);
          setList(forgetPenName(ownerDid, did));
          setSession(loadPenSession());
        }}
      />

      {message && <StatusMessage ok={message.ok} text={message.text} />}

      {session && entry && (
        <SignedInPanel
          ctx={ctx}
          facts={facts}
          session={session}
          entry={entry}
          penPhrase={penPhrase}
          onPenPhrase={setPenPhrase}
          onSignOut={async () => { await signOutPenName(); setPenPhrase(null); setSession(null); }}
          onMoved={() => reload()}
          onEnded={(text) => { setPenPhrase(null); reload(); setMessage({ ok: true, text }); }}
          mode={mode}
          ownerAccessJwt={accessToken}
        />
      )}
    </>
  );
}

function SignedInPanel({ ctx, facts, session, entry, penPhrase, onPenPhrase, onSignOut, onMoved, onEnded, mode, ownerAccessJwt }: {
  ctx: AccountContext;
  facts: ServerFacts;
  session: PenSession;
  entry: PenNameEntry;
  penPhrase: string | null;
  onPenPhrase: (p: string) => void;
  onSignOut: () => Promise<void>;
  onMoved: (e: PenNameEntry) => void;
  onEnded: (text: string) => void;
  mode: AccountContext['mode'];
  ownerAccessJwt: string;
}) {
  const [passkey, setPasskey] = useState<{ ok: boolean; text: string } | null | undefined>(undefined);
  const hasPasskey = !!loadPenPasskey(session.did);
  return (
    <section id="pen-session" aria-labelledby="pen-session-title" className="space-y-4 rounded-xl border-2 border-dashed border-violet-600/50 bg-card p-4 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 id="pen-session-title" className="flex flex-wrap items-center gap-2 text-lg font-semibold leading-tight">
            <VenetianMask className="size-5" aria-hidden />
            Signed in as {session.handle}
            <Badge variant="outline">Pen name</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            In this tab only, at {session.home.url.replace(/^https?:\/\//, '')}. Everything in this box acts as the pen name, with its own session; your own account stays signed in separately and is never sent along.
          </p>
        </div>
        <Button type="button" variant="outline" className="shrink-0" onClick={() => void onSignOut()}><LogOut className="size-4" aria-hidden />Sign out of the pen name</Button>
      </div>

      {penPhrase && !hasPasskey && passkey === undefined && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Unlock it with a passkey next time</summary>
          <div className="mt-3"><PenPasskeyOffer penDid={session.did} phrase={penPhrase} onDone={setPasskey} /></div>
        </details>
      )}
      {passkey && <StatusMessage ok={passkey.ok} text={passkey.text} />}

      <Tabs defaultValue="publish">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="publish">Publish</TabsTrigger>
          <TabsTrigger value="files">Files &amp; backup</TabsTrigger>
          <TabsTrigger value="prove">Prove it&apos;s yours</TabsTrigger>
          <TabsTrigger value="move">Move</TabsTrigger>
          <TabsTrigger value="end">End</TabsTrigger>
        </TabsList>
        <TabsContent value="publish" className="pt-4"><PublishClaim session={session} /></TabsContent>
        <TabsContent value="files" className="pt-4"><PenFiles session={session} /></TabsContent>
        <TabsContent value="prove" className="pt-4">
          <ProveSection session={session} ownerDid={ctx.did} ownerAccessJwt={ownerAccessJwt} ownerPdsUrl={THIS_PDS} mode={mode}
            plcUrl={facts.plcUrl} penPhrase={penPhrase} onPenPhrase={onPenPhrase} />
        </TabsContent>
        <TabsContent value="move" className="pt-4">
          <MovePenName ownerDid={ctx.did} entry={entry} session={session} plcUrl={facts.plcUrl} penPhrase={penPhrase} onPenPhrase={onPenPhrase} onMoved={onMoved} />
        </TabsContent>
        <TabsContent value="end" className="pt-4">
          <EndPenName ownerDid={ctx.did} entry={entry} session={session} plcUrl={facts.plcUrl} onEnded={onEnded} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
