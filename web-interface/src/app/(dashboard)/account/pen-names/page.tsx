'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { PassesSection } from '@/components/pen-names/passes-section';
import { UseSection } from '@/components/pen-names/use-section';
import { serverProblem } from '@/lib/pen-names/service-pin';
import { PenSessionPanel } from '@/components/pen-names/pen-session-panel';
import { identityPolicy } from '@/lib/custody/custody';
import {
  forgetPenName, loadPenNames, loadPenSession, serverFacts, signOutPenName,
  type PenNameEntry, type PenSession, type ServerFacts,
} from '@/lib/pen-names/pen-names';
import { PEN_CHECKLIST, PEN_LIMIT, PEN_NAMES } from '@/lib/copy/glossary';
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

/** An address to open elsewhere (Tor Browser, another browser): shown, copyable, and a plain link. */
function Address({ path, label }: { path: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">{label}</p>
      <p className="break-all rounded-md bg-muted/50 p-2 font-mono text-xs">{url}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={async () => {
          try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select the text instead */ }
        }}>{copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}{copied ? 'Copied' : 'Copy the address'}</Button>
        {/* A full page load: the signed-out pages never get this tab's session. */}
        <Button type="button" size="sm" variant="ghost" asChild>
          <a href={path} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" aria-hidden />Open it here anyway</a>
        </Button>
      </div>
    </div>
  );
}

function PenNameScreens({ ctx, creationAllowed }: { ctx: AccountContext; creationAllowed: boolean }) {
  const { did: ownerDid, accessToken, mode } = ctx;
  const server = useQuery({ queryKey: ['pen-server', THIS_PDS], queryFn: () => serverFacts(THIS_PDS) });

  if (server.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (server.error || !server.data) {
    return <StatusMessage ok={false} text={serverProblem(server.error, "Could not read this server's settings")} />;
  }
  const facts: ServerFacts = server.data;

  return (
    <>
      {creationAllowed && facts.pseudonymsEnabled && (
        <PassesSection pdsUrl={THIS_PDS} ownerDid={ownerDid} ownerAccessJwt={accessToken} />
      )}

      <Section id="apart" title="Create and use a pen name, apart from your account"
        description="Pen names are made and used on pages that need no sign-in, so nothing ties them to your account's session.">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {PEN_CHECKLIST.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <div className="grid gap-3 sm:grid-cols-2">
          <Address path="/pen-names/new" label="Create a pen name (no sign-in)" />
          <Address path="/pen-names" label="Use a pen name (no sign-in)" />
        </div>
        <div className="space-y-2 rounded-md border border-amber-600/40 p-3 text-sm">
          <h3 className="font-semibold">What this protects, and what it doesn&apos;t</h3>
          <p>{PEN_LIMIT.server}</p>
          <p>{PEN_LIMIT.timing}</p>
        </div>
      </Section>

      <ProveFromAccount ownerDid={ownerDid} accessToken={accessToken} mode={mode} facts={facts} />
    </>
  );
}

/**
 * The one thing done as a pen name from inside the account: the proof that
 * names the account, which needs both. Doing it here connects them on
 * purpose, so it stays folded away until the person asks for it.
 */
function ProveFromAccount({ ownerDid, accessToken, mode, facts }: { ownerDid: string; accessToken: string; mode: AccountContext['mode']; facts: ServerFacts }) {
  const [list, setList] = useState<PenNameEntry[]>([]);
  const [session, setSession] = useState<PenSession | null>(null);
  const [penPhrase, setPenPhrase] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(() => {
    setList(loadPenNames(ownerDid));
    setSession(loadPenSession());
  }, [ownerDid]);
  // Browser storage exists only after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  const entry = session ? (list.find((e) => e.did === session.did) ?? { did: session.did, handle: session.handle, home: session.home }) : null;

  return (
    <Section id="prove" title="Prove a pen name is yours" description={<WhatIsThis term="pen-proof" />}>
      <details className="rounded-md border p-4" open={session ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">I have decided to reveal that a pen name is mine</summary>
        <div className="mt-3 space-y-4">
          <Note>
            A proof that names your account is signed by the pen name and by your account, so it is made here, signed in to both in this tab.
            Signing in as a pen name here tells this server that the two belong together, even before you show the proof to anyone.
            For anything else, use the pen name on the signed-out page instead.
          </Note>
          <UseSection
            scope={ownerDid}
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
            <PenSessionPanel
              scope={ownerDid}
              facts={facts}
              session={session}
              entry={entry}
              penPhrase={penPhrase}
              onPenPhrase={setPenPhrase}
              onSignOut={async () => { await signOutPenName(); setPenPhrase(null); setSession(null); }}
              onMoved={() => reload()}
              onEnded={(text) => { setPenPhrase(null); reload(); setMessage({ ok: true, text }); }}
              owner={{ did: ownerDid, accessJwt: accessToken, pdsUrl: THIS_PDS, mode }}
              tabs={['prove']}
              note="The pen name has its own session; your account's sign-in is never sent with its requests, nor its with yours."
            />
          )}
        </div>
      </details>
    </Section>
  );
}
