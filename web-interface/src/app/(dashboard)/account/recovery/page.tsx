'use client';

import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { AccountGate, type AccountContext } from '@/components/account/account-gate';
import { Note, Section, StatusMessage, WhatIsThis } from '@/components/account/explain';
import { PasskeyOffer } from '@/components/account/passkey-offer';
import { RecoverySection } from '@/components/custody/recovery-section';
import { forgetRemembered } from '@/lib/custody/custody';
import { CUSTODY, RECOVERY, RECOVERY_FACTS, type RecoveryOption } from '@/lib/copy/glossary';

export default function RecoveryPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Recovery" description="A way back in if you lose your 12 words." />
      <AccountGate>{(ctx) => <RecoveryScreens ctx={ctx} />}</AccountGate>
    </div>
  );
}

const OPTIONS: RecoveryOption[] = ['none', 'phrase', 'contacts', 'newsroom'];

function RecoveryScreens({ ctx }: { ctx: AccountContext }) {
  const { did, handle, mode } = ctx;
  const [offerRemember, setOfferRemember] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (mode === 'custodial') {
    return (
      <Section title="This server is your recovery" description={`Your account is ${CUSTODY.custodial.title}: you have no 12 words to lose.`}>
        <p className="text-sm">{CUSTODY.custodial.restore}</p>
        <Note>
          Backup phrases and shares are for Assisted and Self accounts, where you hold your own 12 words.
          {' '}<Link href="/account/identity" className="underline underline-offset-4 hover:no-underline">Compare the options in Identity &amp; keys</Link>.
        </Note>
      </Section>
    );
  }

  return (
    <>
      <Section id="status" title="Your recovery" description={<>Optional: a second way back in that you hold yourself, kept as a backup phrase or as shares. <WhatIsThis term="recovery" className="mt-1" /></>}>
        <RecoverySection did={did} mode={mode} onActive={() => { /* steps open in place */ }} onChanged={() => setMessage(null)}
          onRecovered={(newPhrase) => { forgetRemembered(did); setOfferRemember(newPhrase); }} />
        {offerRemember && (
          <PasskeyOffer did={did} handle={handle} phrase={offerRemember} heading="Use a passkey for your new 12 words on this device?"
            onDone={(r) => { setOfferRemember(null); if (r) setMessage(r); }} />
        )}
        {message && <StatusMessage ok={message.ok} text={message.text} />}
        {mode === 'assisted' && (
          <Note>
            Lost your 12 words and have no backup? In Assisted this server can help:{' '}
            <Link href="/account/identity#lost" className="underline underline-offset-4 hover:no-underline">get new 12 words after its operator checks who you are</Link>.
          </Note>
        )}
      </Section>

      <Section id="compare" title="The options side by side" description="What each one protects you against, and who must help.">
        <div className="space-y-3 md:hidden">
          {OPTIONS.map((o) => (
            <div key={o} className="rounded-md border p-3 text-sm">
              <h3 className="font-semibold">{RECOVERY[o].title}</h3>
              <p className="text-muted-foreground">{RECOVERY[o].summary}</p>
              <dl className="mt-2 space-y-1">
                <div><dt className="inline font-medium">Protects against: </dt><dd className="inline text-muted-foreground">{RECOVERY[o].protects}</dd></div>
                <div><dt className="inline font-medium">Who must help: </dt><dd className="inline text-muted-foreground">{RECOVERY[o].who}</dd></div>
                <div><dt className="inline font-medium">What can go wrong: </dt><dd className="inline text-muted-foreground">{RECOVERY[o].wrong}</dd></div>
              </dl>
            </div>
          ))}
        </div>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Recovery options compared</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pr-3 font-medium">Option</th>
                <th scope="col" className="py-2 pr-3 font-medium">Protects against</th>
                <th scope="col" className="py-2 pr-3 font-medium">Who must help</th>
                <th scope="col" className="py-2 font-medium">What can go wrong</th>
              </tr>
            </thead>
            <tbody>
              {OPTIONS.map((o) => (
                <tr key={o} className="border-b align-top last:border-0">
                  <th scope="row" className="py-2 pr-3 font-medium">{RECOVERY[o].title}</th>
                  <td className="py-2 pr-3 text-muted-foreground">{RECOVERY[o].protects}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{RECOVERY[o].who}</td>
                  <td className="py-2 text-muted-foreground">{RECOVERY[o].wrong}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="text-sm font-semibold">True for every option</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {RECOVERY_FACTS.map((f) => <li key={f}>{f}</li>)}
          <li>Because nobody emails you when a recovery starts, check <Link href="/account/history" className="underline underline-offset-4 hover:no-underline">Identity changes</Link> now and then.</li>
        </ul>
      </Section>
    </>
  );
}
