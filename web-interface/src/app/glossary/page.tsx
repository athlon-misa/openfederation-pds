'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ChoiceExplainer } from '@/components/account/explain';
import { CUSTODY, GLOSSARY_SECTIONS, POSTING_KEY_NOTE, RECOVERY, type CustodyMode } from '@/lib/copy/glossary';
import { useAuthStore } from '@/store/auth-store';

const MODES: CustodyMode[] = ['custodial', 'assisted', 'self'];
const slug = (s: string) => `section-${s.toLowerCase().replace(/\W+/g, '-')}`;

/** The glossary (#404): public, so sign-up can link to it too. */
export default function GlossaryPage() {
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  const back = signedIn ? { href: '/account', label: 'Back to your account' } : { href: '/login', label: 'Back to sign in' };
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <Link href={back.href} className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> {back.label}
      </Link>
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Glossary</h1>
        <p className="text-muted-foreground">
          The words these pages use for your identity, its keys and how to get back in. The same words are used on every screen; where a technical name exists, it is given next to the plain one.
        </p>
      </header>

      <nav aria-label="Glossary sections">
        <ul className="flex flex-wrap gap-2 text-sm">
          {GLOSSARY_SECTIONS.map((s) => (
            <li key={s.title}><a href={`#${slug(s.title)}`} className="rounded-md border px-3 py-1.5 hover:bg-accent">{s.title}</a></li>
          ))}
          <li><a href="#compare-modes" className="rounded-md border px-3 py-1.5 hover:bg-accent">Comparing the three modes</a></li>
        </ul>
      </nav>

      {GLOSSARY_SECTIONS.map((section) => (
        <section key={section.title} id={slug(section.title)} aria-labelledby={`${slug(section.title)}-h`} className="space-y-3">
          <h2 id={`${slug(section.title)}-h`} className="text-xl font-semibold">{section.title}</h2>
          <dl className="divide-y rounded-xl border bg-card">
            {section.terms.map((t) => (
              <div key={t.id} id={t.id} className="scroll-mt-4 space-y-1 p-4 target:bg-accent/50">
                <dt className="flex flex-wrap items-center gap-2 font-semibold">
                  {t.term}
                  {t.coming && <Badge variant="outline">{t.coming}</Badge>}
                </dt>
                <dd className="text-sm">{t.text}</dd>
                {t.technical && <dd className="text-xs text-muted-foreground">Technical name: {t.technical}</dd>}
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section id="compare-modes" aria-labelledby="compare-modes-h" className="space-y-4">
        <h2 id="compare-modes-h" className="text-xl font-semibold">Comparing the three modes</h2>
        {MODES.map((m) => (
          <div key={m} className="space-y-3 rounded-xl border bg-card p-4">
            <h3 className="font-semibold">{CUSTODY[m].title}: {CUSTODY[m].short.toLowerCase()}</h3>
            <ChoiceExplainer text={CUSTODY[m]} extra={[{ label: 'If you lose access', text: CUSTODY[m].restore }]} />
          </div>
        ))}
        <p className="text-sm text-muted-foreground">{POSTING_KEY_NOTE}</p>
      </section>

      <section aria-labelledby="compare-recovery-h" className="space-y-4">
        <h2 id="compare-recovery-h" className="text-xl font-semibold">Comparing the recovery options</h2>
        {(['phrase', 'contacts', 'newsroom'] as const).map((o) => (
          <div key={o} className="space-y-3 rounded-xl border bg-card p-4">
            <h3 className="font-semibold">{RECOVERY[o].title}</h3>
            <ChoiceExplainer text={RECOVERY[o]} extra={[{ label: 'Who must help to recover', text: RECOVERY[o].who }]} />
          </div>
        ))}
      </section>
    </main>
  );
}
