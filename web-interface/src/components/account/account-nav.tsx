'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, History, KeyRound, LifeBuoy, MonitorSmartphone, Truck, UserRound, VenetianMask, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The account area, by what people want to do (#404). Also used by the command palette. */
export const ACCOUNT_SECTIONS: { title: string; href: string; icon: LucideIcon; hint: string }[] = [
  { title: 'Your account', href: '/account', icon: UserRound, hint: 'Handle, email, password' },
  { title: 'Identity & keys', href: '/account/identity', icon: KeyRound, hint: 'Who controls your identity' },
  { title: 'Recovery', href: '/account/recovery', icon: LifeBuoy, hint: 'A way back in if you lose your 12 words' },
  { title: 'Devices & passkeys', href: '/account/devices', icon: MonitorSmartphone, hint: 'Where you are signed in, passkey on this device' },
  { title: 'Identity changes', href: '/account/history', icon: History, hint: 'Every change to your identity; cancel recent ones' },
  { title: 'Move to another server', href: '/account/move', icon: Truck, hint: 'Take your account elsewhere' },
  { title: 'Pen names', href: '/account/pen-names', icon: VenetianMask, hint: 'Publishing without your name' },
];

export const GLOSSARY_LINK = { title: 'Glossary', href: '/glossary', icon: BookOpen, hint: 'The words used on these pages' };

export function isAccountSectionActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return href === '/account' ? pathname === '/account' : pathname.startsWith(href);
}

/** Sub-navigation of the account area: a column on wide screens, a scrolling row on phones. */
export function AccountNav() {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  // On phones the row scrolls: keep the current section in view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);
  return (
    <nav ref={navRef} aria-label="Account sections" className="md:w-56 md:shrink-0">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-2 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
        {[...ACCOUNT_SECTIONS, GLOSSARY_LINK].map((s) => {
          const active = isAccountSectionActive(pathname, s.href);
          return (
            <li key={s.href} className={cn(s === GLOSSARY_LINK && 'md:mt-3 md:border-t md:pt-3')}>
              <Link
                href={s.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 whitespace-nowrap rounded-md border px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 md:border-transparent',
                  active ? 'border-primary bg-accent font-medium text-accent-foreground md:border-transparent' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <s.icon className="size-4 shrink-0" aria-hidden />
                <span>{s.title}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
