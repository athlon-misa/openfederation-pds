'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QrCode } from '@/components/custody/qr-code';
import { groupText, passExpiry, passToText, type Pass } from '@/lib/pen-names/pass-file';
import { PASS_PRINT } from '@/lib/copy/glossary';

const host = (url: string) => url.replace(/^https?:\/\//, '');
const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** One printed pass: its QR code, its text with the checksum, and how to use it. */
function PassPage({ pass, server, owner, createUrl }: { pass: Pass; server: string; owner: string; createUrl: string }) {
  const text = passToText(pass, { server, owner });
  const sum = text.slice(text.lastIndexOf('~') + 1);
  return (
    <section className="pen-print-page space-y-4 p-8 text-black">
      <h1 className="text-2xl font-bold">Pen-name pass</h1>
      <p>Creates one pen name on <strong>{host(server)}</strong>. Valid until {day(new Date(passExpiry(pass.epoch).getTime() - 1))}.</p>
      <QrCode text={text} label="QR code of this pass" size={300} />
      <div className="space-y-1">
        <p className="text-sm">The same pass as text ({text.length} characters; spaces and line breaks do not matter):</p>
        <p className="break-all font-mono text-xs leading-relaxed">{groupText(text.slice(0, -sum.length))} <strong>{sum}</strong></p>
        <p className="text-sm">Checksum (the last group, in bold): <span className="font-mono font-semibold">{sum}</span></p>
      </div>
      <div className="space-y-1 text-sm">
        <p><strong>To use it:</strong> open {createUrl} in Tor Browser (or another browser, on another network), and paste or type the text. A phone&apos;s camera or QR app reads the QR code into text you can copy.</p>
        <p>{PASS_PRINT.wrong}</p>
      </div>
    </section>
  );
}

/**
 * Prints the given passes, one per page, then calls `onDone`. Only the pass
 * pages print (globals.css). Nothing leaves this device.
 */
export function PrintPasses({ passes, server, owner, onDone }: { passes: Pass[]; server: string; owner: string; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  const finished = useRef(onDone);
  useEffect(() => { finished.current = onDone; }, [onDone]);
  const createUrl = typeof window === 'undefined' ? '/pen-names/new' : `${window.location.origin}/pen-names/new`;

  // The portal target exists only in the browser.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setReady(true); }, []);

  useEffect(() => {
    if (!ready) return;
    document.body.classList.add('pen-printing');
    const done = () => { document.body.classList.remove('pen-printing'); finished.current(); };
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 50);
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); document.body.classList.remove('pen-printing'); };
  }, [ready]);

  if (!ready) return null;
  return createPortal(
    <div className="pen-print-root bg-white">
      {passes.map((p) => <PassPage key={p.signature} pass={p} server={server} owner={owner} createUrl={createUrl} />)}
    </div>,
    document.body,
  );
}
