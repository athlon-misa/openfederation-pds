'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { glossaryTerm, type ChoiceText } from '@/lib/copy/glossary';
import { cn } from '@/lib/utils';

/**
 * Shared pieces of the account screens (#404): the four answers every risky
 * choice gives, the specific acknowledgement before committing, inline
 * "what does this mean?" and status messages that do not rely on colour.
 */

const PARTS: { key: keyof Pick<ChoiceText, 'means' | 'responsible' | 'wrong' | 'undo'>; label: string }[] = [
  { key: 'means', label: 'What it means' },
  { key: 'responsible', label: 'What you are responsible for' },
  { key: 'wrong', label: 'What can go wrong' },
  { key: 'undo', label: 'How to undo it' },
];

/** What it means, what you are responsible for, what can go wrong, how to undo it. */
export function ChoiceExplainer({ text, className, extra }: {
  text: Pick<ChoiceText, 'means' | 'responsible' | 'wrong' | 'undo'>;
  className?: string;
  /** Rows added after the four, for example "Who must help". */
  extra?: { label: string; text: string }[];
}) {
  const rows = [...PARTS.map((p) => ({ label: p.label, text: text[p.key] })), ...(extra ?? [])];
  return (
    <dl className={cn('choice-explainer space-y-3 text-sm', className)}>
      {rows.map((row) => (
        <div key={row.label} className="choice-row">
          <dt className="font-medium">{row.label}</dt>
          <dd className="mt-0.5 text-muted-foreground">{row.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The specific thing the person confirms before a risky step: a checkbox, never just "OK". */
export function Acknowledge({ id, text, checked, onChange, disabled }: {
  id: string;
  text: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border status-warning p-3 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className="cursor-pointer font-medium leading-snug">{text}</label>
    </div>
  );
}

/** An inline "What does … mean?", opened in place, with a link to the glossary. */
export function WhatIsThis({ term, label, className }: { term: string; label?: string; className?: string }) {
  const t = glossaryTerm(term);
  return (
    <details className={cn('group text-sm', className)}>
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <Info className="size-3.5" aria-hidden />
        {label ?? `What does “${t.term}” mean?`}
      </summary>
      <div className="mt-2 space-y-1 rounded-md border bg-muted/40 p-3">
        <p>{t.text}</p>
        {t.technical && <p className="text-xs text-muted-foreground">Technical name: {t.technical}.</p>}
        <p><Link href={`/glossary#${t.id}`} className="text-xs underline underline-offset-4 hover:no-underline">More in the glossary</Link></p>
      </div>
    </details>
  );
}

/** A result or error, with an icon and a word as well as colour. */
export function StatusMessage({ ok, text, className }: { ok: boolean; text: string; className?: string }) {
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <p role="status" className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', ok ? 'status-success' : 'border-destructive/40 text-destructive', className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span><span className="sr-only">{ok ? 'Done: ' : 'Problem: '}</span>{text}</span>
    </p>
  );
}

/** A short, calm note (not an error). */
export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground', className)}>
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** A section of an account page: a real heading, so the page outline makes sense. */
export function Section({ title, description, children, id, className }: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={cn('space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6', className)}>
      <div className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold leading-tight">{title}</h2>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {children}
    </section>
  );
}
