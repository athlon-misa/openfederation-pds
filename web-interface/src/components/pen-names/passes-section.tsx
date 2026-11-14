'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { collectPasses, hasThisMonthsPasses, PASSES_PER_MONTH_DEFAULT } from '@/lib/pen-names/pen-names';
import { PASSES } from '@/lib/copy/glossary';

function nextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Collect this month's passes, signed in as the person. They stay in this browser. */
export function PassesSection({ pdsUrl, ownerDid, ownerAccessJwt, left, onChange }: {
  pdsUrl: string;
  ownerDid: string;
  ownerAccessJwt: string;
  left: number;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const collected = hasThisMonthsPasses(ownerDid);

  async function collect() {
    setBusy(true); setMessage(null);
    try {
      const n = await collectPasses({ pdsUrl, ownerDid, ownerAccessJwt, count: PASSES_PER_MONTH_DEFAULT });
      setMessage({ ok: true, text: `Collected ${n} ${n === 1 ? 'pass' : 'passes'}. They are kept in this browser.` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); onChange(); }
  }

  return (
    <Section id="passes" title="Passes" description={<>{PASSES.means} <WhatIsThis term="pass" className="mt-1" /></>}>
      <p className="text-2xl font-semibold" aria-live="polite">
        {left} {left === 1 ? 'pass' : 'passes'} left this month
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{PASSES.seen}</li>
        <li>{PASSES.kept}</li>
      </ul>
      {!collected && (
        <Button type="button" onClick={collect} disabled={busy}>{busy ? 'Collecting…' : 'Collect this month’s passes'}</Button>
      )}
      {collected && left === 0 && <Note>You have used this month&apos;s passes. New ones from {nextMonth()}.</Note>}
      {collected && left > 0 && <Note>You collected this month&apos;s passes. You can collect again from {nextMonth()}.</Note>}
      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </Section>
  );
}
