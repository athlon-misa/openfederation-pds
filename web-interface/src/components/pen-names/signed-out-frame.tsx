'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, VenetianMask } from 'lucide-react';
import { ownSessionInThisBrowser } from '@/lib/signed-out-area';
import { SIGNED_IN_HERE } from '@/lib/copy/glossary';
import { cn } from '@/lib/utils';

/**
 * The frame of the signed-out pen-name pages: their own header (no
 * dashboard, no account), and a warning when this browser also holds the
 * person's own session. The session is never loaded here; only whether one
 * exists is checked.
 */
export function SignedOutFrame({ current, children }: { current: 'use' | 'new'; children: React.ReactNode }) {
  const [signedInHere, setSignedInHere] = useState(false);
  useEffect(() => {
    const check = () => setSignedInHere(ownSessionInThisBrowser());
    check(); // browser storage exists only after mount
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);

  const link = (href: string, label: string, here: boolean) => (
    <Link href={href} aria-current={here ? 'page' : undefined}
      className={cn('rounded-md px-2 py-1 text-sm underline-offset-4 hover:underline', here ? 'bg-muted font-medium' : 'text-muted-foreground')}>
      {label}
    </Link>
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:py-10">
      <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 font-semibold"><VenetianMask className="size-5" aria-hidden />Pen names</p>
        <nav aria-label="Pen-name pages" className="flex flex-wrap gap-1">
          {link('/pen-names', 'Use a pen name', current === 'use')}
          {link('/pen-names/new', 'Create a pen name', current === 'new')}
        </nav>
      </header>
      <p className="text-sm text-muted-foreground">
        This page works without signing in to an account, and sends no account&apos;s sign-in with anything it does.
      </p>
      {signedInHere && (
        <div role="alert" className="flex items-start gap-3 rounded-md border-2 border-amber-600/60 bg-amber-500/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
          <div className="space-y-1">
            <p className="font-semibold">{SIGNED_IN_HERE}</p>
            <p className="text-muted-foreground">This page does not use or send that sign-in. But the same browser, network and moment can still connect the two.</p>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
