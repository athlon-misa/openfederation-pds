'use client';

import { Check, Circle, Loader2, X } from 'lucide-react';
import type { MigrationPolicy, TargetInfo } from '@/lib/move/xrpc';

export type StepState = 'todo' | 'active' | 'done' | 'failed';

export function StepList({ steps, current, failed, done }: {
  steps: readonly { id: string; label: string }[];
  current: string | null;
  failed: boolean;
  done: boolean;
}) {
  const index = current ? steps.findIndex((s) => s.id === current) : -1;
  return (
    <ol className="space-y-2" aria-live="polite">
      {steps.map((s, i) => {
        const state: StepState = done || i < index ? 'done' : i === index ? (failed ? 'failed' : 'active') : 'todo';
        return (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            {state === 'done' && <Check className="size-4 text-green-600" aria-label="done" />}
            {state === 'active' && <Loader2 className="size-4 animate-spin" aria-label="in progress" />}
            {state === 'failed' && <X className="size-4 text-destructive" aria-label="failed" />}
            {state === 'todo' && <Circle className="size-4 text-muted-foreground" aria-label="not started" />}
            <span className={state === 'todo' ? 'text-muted-foreground' : ''}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** What the new server's published policy means for this move, and whether to start at all. */
export function policyNote(policy: MigrationPolicy | undefined, what: 'accounts' | 'communities', target: TargetInfo | null): { text: string; blocked: boolean; needsInvite: boolean } {
  if (!target) return { text: '', blocked: false, needsInvite: false };
  if (!target.migration) {
    return { text: `That server does not say whether it accepts ${what} moving in (it may not be an OpenFederation server). It may refuse the move; nothing changes here if it does.`, blocked: false, needsInvite: false };
  }
  switch (policy) {
    case 'open': return { text: `That server accepts ${what} moving in.`, blocked: false, needsInvite: false };
    case 'invite': return { text: `That server accepts ${what} moving in with an invite code from it. Ask the people who run it for one.`, blocked: false, needsInvite: true };
    case 'closed': return { text: `That server does not accept ${what} moving in.`, blocked: true, needsInvite: false };
    default: return { text: 'That server did not say whether it accepts this move.', blocked: false, needsInvite: false };
  }
}
