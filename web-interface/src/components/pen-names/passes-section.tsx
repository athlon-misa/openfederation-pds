'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Acknowledge, ChoiceExplainer, Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import {
  autoCollectPasses, passesStatus, passFileBlob, removePasses, PASSES_CHANGED, type PassesStatus,
} from '@/lib/pen-names/pen-names';
import { passExpiry, passId, type Pass } from '@/lib/pen-names/pass-file';
import { PASSES, PASS_FILE, PASS_PRINT, REMOVE_AFTER_COPY } from '@/lib/copy/glossary';
import { saveFile } from './pen-parts';
import { PrintPasses } from './pass-print';

const month = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' });
const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

function nextMonth(): string {
  const d = new Date();
  return day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

/** The passes that expire first come first: they are the ones to use up. */
function soonestFirst(passes: Pass[]): Pass[] {
  return [...passes].sort((a, b) => a.epoch.localeCompare(b.epoch));
}

/** After passes were copied out of this browser: offer to remove them here, so none is used twice. */
function RemoveCopied({ ids, what, onRemove, onDone }: { ids: string[]; what: string; onRemove: (ids: string[]) => void; onDone: (text: string | null) => void }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" role="group" aria-label="Remove the copied passes from this browser?">
      <p>{what} {REMOVE_AFTER_COPY}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => { onRemove(ids); onDone(`Removed ${plural(ids.length)} from this browser.`); }}>
          Remove {ids.length === 1 ? 'it' : `these ${ids.length}`} from this browser
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone(null)}>Keep {ids.length === 1 ? 'it' : 'them'} here too</Button>
      </div>
    </div>
  );
}

/**
 * This month's passes, collected automatically (components/pen-names/pass-collector.tsx),
 * and how to take them out of this browser: a file, or printed.
 */
export function PassesSection({ pdsUrl, ownerDid, ownerAccessJwt }: { pdsUrl: string; ownerDid: string; ownerAccessJwt: string }) {
  const [status, setStatus] = useState<PassesStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'none' | 'file' | 'print'>('none');
  const [fileAck, setFileAck] = useState(false);
  const [printCount, setPrintCount] = useState('1');
  const [printing, setPrinting] = useState<Pass[] | null>(null);
  const [copied, setCopied] = useState<{ ids: string[]; what: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(() => setStatus(passesStatus(ownerDid)), [ownerDid]);

  useEffect(() => {
    // Browser storage exists only after mount; collection may be running from the layout already.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    window.addEventListener(PASSES_CHANGED, reload);
    window.addEventListener('storage', reload);
    return () => { window.removeEventListener(PASSES_CHANGED, reload); window.removeEventListener('storage', reload); };
  }, [reload]);

  async function retry() {
    setBusy(true); setMessage(null);
    try { setStatus(await autoCollectPasses({ pdsUrl, ownerDid, ownerAccessJwt, force: true })); } finally { setBusy(false); }
  }

  function saveToFile() {
    if (!status) return;
    const passes = status.passes;
    const stamp = new Date().toISOString().slice(0, 10);
    saveFile(passFileBlob({ server: pdsUrl, owner: ownerDid, passes }), `pen-name-passes-${stamp}.json`);
    setPanel('none'); setFileAck(false);
    setCopied({ ids: passes.map(passId), what: `Saved ${plural(passes.length)} to pen-name-passes-${stamp}.json.` });
  }

  function print() {
    if (!status) return;
    const n = Math.max(1, Math.min(status.passes.length, Number(printCount) || 1));
    setPrinting(soonestFirst(status.passes).slice(0, n));
  }

  const passes = status?.passes ?? [];
  const lastExpiry = passes.length ? passExpiry(soonestFirst(passes)[passes.length - 1].epoch) : null;
  const soonest = passes.length ? passExpiry(soonestFirst(passes)[0].epoch) : null;

  return (
    <Section id="passes" title="Passes" description={<>{PASSES.means} <WhatIsThis term="pass" className="mt-1" /></>}>
      <div aria-live="polite" className="space-y-1">
        {!status ? <p className="text-sm text-muted-foreground">Checking…</p> : (
          <>
            <p className="text-2xl font-semibold">{plural(passes.length)}{status.thisMonth === 'here' && status.collectedAt ? `, collected ${month(status.collectedAt)}` : ''}</p>
            {soonest && lastExpiry && (
              <p className="text-sm text-muted-foreground">
                {soonest.getTime() === lastExpiry.getTime()
                  ? `They work until ${day(new Date(soonest.getTime() - 1))}.`
                  : `Some work until ${day(new Date(soonest.getTime() - 1))}, the rest until ${day(new Date(lastExpiry.getTime() - 1))}.`}
              </p>
            )}
          </>
        )}
      </div>

      {status?.thisMonth === 'not-yet' && !status.lastFailure && <Note>This month&apos;s passes are being collected for you.</Note>}
      {status?.thisMonth === 'elsewhere' && (
        <Note>This month&apos;s passes for your account were collected in another browser or app, so they are kept there. Save them to a file there to use them elsewhere. New passes come on {nextMonth()}.</Note>
      )}
      {status?.thisMonth === 'here' && <Note>You have this month&apos;s passes. The next batch comes on {nextMonth()}, whether or not you use these.</Note>}
      {status?.lastFailure && status.thisMonth === 'not-yet' && (
        <div className="space-y-2">
          <StatusMessage ok={false} text={`Could not collect this month's passes yet: ${status.lastFailure.message}`} />
          <Button type="button" variant="outline" size="sm" onClick={retry} disabled={busy}>{busy ? 'Collecting…' : 'Try again now'}</Button>
        </div>
      )}

      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{PASSES.auto}</li>
        <li>{PASSES.seen}</li>
        <li>{PASSES.kept}</li>
      </ul>

      {passes.length > 0 && panel === 'none' && !copied && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => { setPanel('file'); setMessage(null); }}><Download className="size-4" aria-hidden />Save my passes to a file…</Button>
          <Button type="button" variant="outline" onClick={() => { setPanel('print'); setMessage(null); }}><Printer className="size-4" aria-hidden />Print a pass…</Button>
        </div>
      )}

      {panel === 'file' && (
        <div className="space-y-3 rounded-md border p-4">
          <h3 className="text-sm font-semibold">{PASS_FILE.title}</h3>
          <p className="text-sm">{PASS_FILE.summary}</p>
          <ChoiceExplainer text={PASS_FILE} />
          <Acknowledge id="pass-file-ack" checked={fileAck} onChange={setFileAck}
            text={`I understand that anyone with this file can create pen names on this server with these ${plural(passes.length)}, but cannot link them to me, and that I keep the file private.`} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!fileAck} onClick={saveToFile}><Download className="size-4" aria-hidden />Save {plural(passes.length)} to a file</Button>
            <Button type="button" variant="ghost" onClick={() => { setPanel('none'); setFileAck(false); }}>Not now</Button>
          </div>
        </div>
      )}

      {panel === 'print' && (
        <div className="space-y-3 rounded-md border p-4">
          <h3 className="text-sm font-semibold">Print a pass</h3>
          <p className="text-sm">{PASS_PRINT.means}</p>
          <p className="text-sm text-muted-foreground">{PASS_PRINT.wrong}</p>
          <div className="space-y-2">
            <Label htmlFor="print-count">How many passes (one per page)</Label>
            <Input id="print-count" type="number" inputMode="numeric" min={1} max={passes.length} className="max-w-24" value={printCount}
              onChange={(e) => setPrintCount(e.target.value)} aria-describedby="print-count-hint" />
            <p id="print-count-hint" className="text-xs text-muted-foreground">The ones that expire first. You have {plural(passes.length)}.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={print}><Printer className="size-4" aria-hidden />Print</Button>
            <Button type="button" variant="ghost" onClick={() => setPanel('none')}>Not now</Button>
          </div>
        </div>
      )}

      {printing && status && (
        <PrintPasses passes={printing} server={pdsUrl} owner={ownerDid} onDone={() => {
          const ids = printing.map(passId);
          setPrinting(null); setPanel('none');
          setCopied({ ids, what: `Sent ${plural(ids.length)} to the printer.` });
        }} />
      )}

      {copied && (
        <RemoveCopied ids={copied.ids} what={copied.what} onRemove={(ids) => { removePasses(ownerDid, ids); reload(); }} onDone={(text) => { setCopied(null); if (text) setMessage({ ok: true, text }); }} />
      )}
      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </Section>
  );
}
