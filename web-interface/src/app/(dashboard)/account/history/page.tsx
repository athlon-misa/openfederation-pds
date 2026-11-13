'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { ExistingPhrase } from '@/components/custody/phrase-inputs';
import { CANCEL_WINDOW, cancelIdentityChange, currentRecoveryKey, identityHistory, type IdentityChange } from '@/lib/custody/custody';
import { CANCEL_CHANGE } from '@/lib/copy/glossary';
import { THIS_PDS } from '@/hooks/use-identity';

export default function HistoryPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Identity changes" description="Every change to your identity, as the public directory records it. Recent changes made with a backup key can be cancelled." />
      <AccountGate>{(ctx) => <History ctx={ctx} />}</AccountGate>
    </div>
  );
}

/** Who signed a change, in plain words. */
function signerText(c: IdentityChange, recoveryKey: string | null): string {
  if (c.signerRank === undefined || c.signerRank < 0) return 'a key the dashboard could not identify';
  if (!c.personHeld) return 'this server (your account was Custodial then)';
  if (c.signerRank === 0) return 'you, with your 12 words';
  if (recoveryKey && c.signedBy === recoveryKey) return 'your recovery (backup phrase or shares)';
  return 'a backup key: this server\'s backup, or a recovery you had then';
}

function History({ ctx }: { ctx: AccountContext }) {
  const { did, mode } = ctx;
  const history = useQuery({
    queryKey: ['identity-history', did],
    queryFn: async () => {
      const [h, recoveryKey] = await Promise.all([
        identityHistory(THIS_PDS, did),
        mode === 'custodial' ? Promise.resolve(null) : currentRecoveryKey(THIS_PDS, did, mode).catch(() => null),
      ]);
      return { ...h, recoveryKey };
    },
  });
  const [cancelling, setCancelling] = useState<IdentityChange | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function cancel(phrase: string) {
    if (!cancelling) return;
    setBusy(true); setMessage(null);
    try {
      await cancelIdentityChange({ pdsUrl: THIS_PDS, did, phrase, change: cancelling });
      setMessage({ ok: true, text: 'The change is cancelled: your identity is back to how it was before it. If you did not make that change, change your password now.' });
      setCancelling(null); setAck(false);
      await history.refetch();
      await ctx.refresh();
    } catch (e) {
      setMessage({ ok: false, text: `${(e as Error).message.replace(/\.+$/, '')}. Nothing was changed.` });
    } finally { setBusy(false); }
  }

  const changes = history.data?.changes ?? [];
  const open = changes.filter((c) => c.cancellable);

  return (
    <>
      <Section
        title="How this works"
        description={<>Your identity has a public entry that anyone can read: which keys control it, which server hosts it and your handle. <WhatIsThis term="directory" className="mt-1" /></>}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {mode === 'custodial' && <li>Your account is Custodial: this server makes these changes for you, and you cannot cancel them.</li>}
          {mode === 'assisted' && <li>If this server uses its backup key, it emails you. For 72 hours your 12 words can cancel what it did.</li>}
          {mode !== 'custodial' && <li>A recovery started with your backup phrase or shares can also be cancelled with your 12 words for 72 hours. Nobody emails you about those, so look here now and then.</li>}
          {mode !== 'custodial' && <li>A change you signed yourself with your 12 words cannot be cancelled; make another change instead.</li>}
        </ul>
      </Section>

      {message && <StatusMessage ok={message.ok} text={message.text} />}

      {open.length > 0 && !cancelling && (
        <StatusMessage ok={false} text={`${open.length === 1 ? 'One recent change was' : `${open.length} recent changes were`} made with a backup key and can still be cancelled. If you did not ask for ${open.length === 1 ? 'it' : 'them'}, cancel now.`} />
      )}

      <Section title="All changes" description="Newest first.">
        {history.isLoading && <Skeleton className="h-32 rounded-md" />}
        {history.isError && <StatusMessage ok={false} text={(history.error as Error).message} />}
        {history.data && (
          <ol className="space-y-3">
            {changes.map((c) => {
              const until = new Date(new Date(c.createdAt).getTime() + CANCEL_WINDOW);
              return (
                <li key={c.cid} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <time dateTime={c.createdAt} className="font-medium">{new Date(c.createdAt).toLocaleString()}</time>
                    {c.cancellable && <Badge variant="destructive">Can be cancelled until {until.toLocaleString()}</Badge>}
                  </div>
                  <p>Changed: {c.summary.join(', ')}.</p>
                  <p className="text-muted-foreground">Made by {signerText(c, history.data.recoveryKey)}.</p>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Technical details</summary>
                    <p className="mt-1 break-all font-mono">Directory entry (PLC operation): {c.cid}</p>
                  </details>
                  {c.cancellable && cancelling?.cid !== c.cid && (
                    <Button type="button" variant="outline" size="sm" disabled={!!cancelling}
                      onClick={() => { setMessage(null); setAck(false); setCancelling(c); }}>Cancel this change…</Button>
                  )}
                  {cancelling?.cid === c.cid && (
                    <div className="space-y-3 rounded-md border p-3">
                      <h3 className="text-sm font-semibold">{CANCEL_CHANGE.title}</h3>
                      <ChoiceExplainer text={CANCEL_CHANGE} />
                      <Acknowledge id="cancel-ack" text="I understand that cancelling puts my identity back to how it was before this change, including the 12 words that controlled it then." checked={ack} onChange={setAck} disabled={busy} />
                      {ack && (busy ? <p className="text-sm text-muted-foreground">Cancelling…</p> : (
                        <>
                          <p className="text-sm">Enter the 12 words you had before this change.</p>
                          <ExistingPhrase did={did} onReady={cancel} />
                        </>
                      ))}
                      <Button type="button" variant="ghost" onClick={() => { setCancelling(null); setAck(false); }} disabled={busy}>Keep this change</Button>
                    </div>
                  )}
                </li>
              );
            })}
            {history.data.created && (
              <li className="rounded-md border p-3 text-sm">
                <time dateTime={history.data.created} className="font-medium">{new Date(history.data.created).toLocaleString()}</time>
                <p>Your identity was created.</p>
              </li>
            )}
          </ol>
        )}
        {history.data && changes.length === 0 && <Note>No changes since your identity was created.</Note>}
      </Section>
    </>
  );
}
