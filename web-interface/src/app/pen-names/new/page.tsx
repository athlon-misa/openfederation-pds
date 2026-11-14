'use client';

/**
 * Create a pen name without signing in (outside the dashboard, like
 * /verify). Passes come from a file, pasted text or a photo of a printed QR
 * code; the person's own session is never loaded or sent from here.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { SignedOutFrame } from '@/components/pen-names/signed-out-frame';
import { LoadPasses } from '@/components/pen-names/load-passes';
import { CreateSection } from '@/components/pen-names/create-section';
import { saveFile } from '@/components/pen-names/pen-parts';
import { passFileBlob, serverFacts, signInPenName, SIGNED_OUT_SCOPE } from '@/lib/pen-names/pen-names';
import { passExpiry, type LoadedPasses } from '@/lib/pen-names/pass-file';
import { THIS_PDS } from '@/lib/this-pds';
import { serverProblem } from '@/lib/pen-names/service-pin';

const host = (url: string) => url.replace(/^https?:\/\//, '');
const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;
const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function CreatePenNamePage() {
  const router = useRouter();
  const server = useQuery({ queryKey: ['pen-server', THIS_PDS], queryFn: () => serverFacts(THIS_PDS) });
  const [loaded, setLoaded] = useState<LoadedPasses | null>(null);
  const [usedSince, setUsedSince] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const passes = loaded?.passes ?? [];
  const latest = passes.length ? passExpiry(passes.map((p) => p.epoch).sort().at(-1)!) : null;

  return (
    <SignedOutFrame current="new">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Create a pen name</h1>
        <div className="text-muted-foreground">
          A separate identity on {host(THIS_PDS)} to publish under, made here with one of your passes. <WhatIsThis term="pen-name" className="mt-1" />
        </div>
      </div>

      {server.isLoading && <Skeleton className="h-40 rounded-xl" />}
      {server.error && <StatusMessage ok={false} text={serverProblem(server.error, 'Could not reach this server')} />}
      {server.data && !server.data.pseudonymsEnabled && (
        <Note>This server does not allow new pen names. Pen names that already exist here keep working: <a className="underline underline-offset-4" href="/pen-names">use one</a>.</Note>
      )}

      {server.data?.pseudonymsEnabled && (
        <>
          <LoadPasses server={THIS_PDS} loaded={loaded} onLoaded={(l) => { setLoaded(l); setMessage(null); }} />

          {loaded && (
            <Section title="Your passes" description="Loaded in this page only. Leaving or reloading the page forgets them; your file is unchanged.">
              <p className="text-2xl font-semibold" aria-live="polite">{plural(passes.length)} loaded</p>
              {latest && <p className="text-sm text-muted-foreground">The last of them work until {day(new Date(latest.getTime() - 1))}.</p>}
              <p className="text-sm text-muted-foreground">
                They came with your account&apos;s DID ({loaded.owner}). A new pen name keeps it sealed in its public entry, unreadable to anyone,
                so that you alone can prove later that the pen name is yours. Nothing here sends it.
              </p>
              {usedSince > 0 && passes.length > 0 && (
                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <p>
                    Your file (or paper) still has the {usedSince === 1 ? 'pass' : `${usedSince} passes`} used here. So that {usedSince === 1 ? 'it is' : 'they are'} not
                    tried again, save the {plural(passes.length)} left to a new file and delete the old one.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={() => {
                    const stamp = new Date().toISOString().slice(0, 10);
                    saveFile(passFileBlob({ server: THIS_PDS, owner: loaded.owner, passes }), `pen-name-passes-${stamp}.json`);
                    setUsedSince(0);
                    setMessage({ ok: true, text: `Saved ${plural(passes.length)} to pen-name-passes-${stamp}.json. Delete the old file.` });
                  }}><Download className="size-4" aria-hidden />Save the {plural(passes.length)} left to a new file</Button>
                </div>
              )}
              {passes.length === 0 && <Note>No passes left in this page. Load more, or wait for next month&apos;s.</Note>}
            </Section>
          )}

          {loaded && (
            <CreateSection
              server={server.data}
              ownerDid={loaded.owner}
              passes={passes}
              scope={SIGNED_OUT_SCOPE}
              onPassUsed={(used) => {
                setLoaded((l) => l && { ...l, passes: l.passes.filter((p) => p.signature !== used.signature) });
                setUsedSince((n) => n + 1);
              }}
              onCreated={() => setMessage(null)}
              onUse={async (created, phrase) => {
                try {
                  await signInPenName(created.home, phrase);
                  router.push('/pen-names');
                } catch (e) { setMessage({ ok: false, text: (e as Error).message }); }
              }}
            />
          )}
          {message && <StatusMessage ok={message.ok} text={message.text} />}
        </>
      )}
    </SignedOutFrame>
  );
}
