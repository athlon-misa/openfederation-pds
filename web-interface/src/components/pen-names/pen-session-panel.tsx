'use client';

import { useState } from 'react';
import { LogOut, VenetianMask } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusMessage } from '@/components/account/explain';
import { loadPenPasskey, type PenNameEntry, type PenSession, type ServerFacts } from '@/lib/pen-names/pen-names';
import { PenFiles, PublishClaim } from './publish-files';
import { ProveSection, type ProofOwner } from './prove-section';
import { EndPenName, MovePenName } from './move-end';
import { PenPasskeyOffer } from './pen-parts';

export type PenTab = 'publish' | 'files' | 'prove' | 'move' | 'end';
const LABELS: Record<PenTab, string> = { publish: 'Publish', files: 'Files & backup', prove: 'Prove it’s yours', move: 'Move', end: 'End' };

/**
 * Everything done as the signed-in pen name, with its own session in this
 * tab: never with the person's. `owner` is set only on the account page,
 * for the proof that names the account.
 */
export function PenSessionPanel({ scope, facts, session, entry, penPhrase, onPenPhrase, onSignOut, onMoved, onEnded, owner, tabs, note }: {
  scope: string;
  facts: ServerFacts;
  session: PenSession;
  entry: PenNameEntry;
  penPhrase: string | null;
  onPenPhrase: (p: string) => void;
  onSignOut: () => Promise<void>;
  onMoved: (e: PenNameEntry) => void;
  onEnded: (text: string) => void;
  owner: ProofOwner | null;
  tabs: PenTab[];
  note: string;
}) {
  const [passkey, setPasskey] = useState<{ ok: boolean; text: string } | null | undefined>(undefined);
  const hasPasskey = !!loadPenPasskey(session.did);
  const content: Record<PenTab, React.ReactNode> = {
    publish: <PublishClaim session={session} />,
    files: <PenFiles session={session} />,
    prove: <ProveSection session={session} owner={owner} plcUrl={facts.plcUrl} penPhrase={penPhrase} onPenPhrase={onPenPhrase} />,
    move: <MovePenName scope={scope} entry={entry} session={session} plcUrl={facts.plcUrl} penPhrase={penPhrase} onPenPhrase={onPenPhrase} onMoved={onMoved} />,
    end: <EndPenName scope={scope} entry={entry} session={session} plcUrl={facts.plcUrl} onEnded={onEnded} />,
  };
  return (
    <section id="pen-session" aria-labelledby="pen-session-title" className="space-y-4 rounded-xl border-2 border-dashed border-violet-600/50 bg-card p-4 shadow-sm sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id="pen-session-title" className="flex flex-wrap items-center gap-2 text-lg font-semibold leading-tight">
            <VenetianMask className="size-5" aria-hidden />
            <span className="break-all">Signed in as {session.handle}</span>
            <Badge variant="outline">Pen name</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">In this tab only, at {session.home.url.replace(/^https?:\/\//, '')}. {note}</p>
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

      {tabs.length === 1 ? <div className="pt-2">{content[tabs[0]]}</div> : (
        <Tabs defaultValue={tabs[0]}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            {tabs.map((t) => <TabsTrigger key={t} value={t}>{LABELS[t]}</TabsTrigger>)}
          </TabsList>
          {tabs.map((t) => <TabsContent key={t} value={t} className="pt-4">{content[t]}</TabsContent>)}
        </Tabs>
      )}
    </section>
  );
}
