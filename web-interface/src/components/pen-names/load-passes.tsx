'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Note, Section, StatusMessage } from '@/components/account/explain';
import { checkPassesAgainstServer } from '@/lib/pen-names/pen-names';
import { parsePasses, PassFileError, type LoadedPasses } from '@/lib/pen-names/pass-file';

interface Detector { detect: (image: ImageBitmapSource) => Promise<{ rawValue: string }[]> }
type DetectorClass = new (opts: { formats: string[] }) => Detector;

/** QR codes can be read from a photo only where the browser has a QR reader built in (Chrome, Edge, Android). */
function qrReader(): DetectorClass | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector ?? null;
}

const plural = (n: number) => `${n} ${n === 1 ? 'pass' : 'passes'}`;

/**
 * Load passes without signing in: from the saved file, pasted text, or a
 * photo of a printed QR code. Everything is read on this device; the passes
 * are then checked against the server's published keys (fetched like anyone
 * would, without credentials). They stay in this page's memory only.
 */
export function LoadPasses({ server, loaded, onLoaded }: { server: string; loaded: LoadedPasses | null; onLoaded: (l: LoadedPasses) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const Reader = qrReader();

  async function take(raw: string) {
    setBusy(true); setMessage(null);
    try {
      const read = parsePasses(raw, { server });
      if (loaded && loaded.owner !== read.owner) throw new PassFileError('Damaged', 'These passes were collected by a different account than the ones already loaded. Reload the page to start again.');
      const { good, bad, retired } = await checkPassesAgainstServer(server, read.passes);
      if (bad) {
        setMessage({ ok: false, text: `${plural(bad)} did not match this server’s published key and ${bad === 1 ? 'was' : 'were'} left out. A server that marks passes could follow them: do not use them, and ask the people who run this server.` });
      }
      if (!good.length) {
        if (!bad) setMessage({ ok: false, text: retired ? 'These passes are from a month whose key this server has retired: they have expired.' : 'No usable passes were found.' });
        return;
      }
      const known = new Set((loaded?.passes ?? []).map((p) => p.signature));
      const fresh = good.filter((p) => !known.has(p.signature));
      const merged: LoadedPasses = { ...read, passes: [...(loaded?.passes ?? []), ...fresh], expired: read.expired + retired };
      onLoaded(merged);
      setText('');
      if (!bad) {
        const left = read.expired + retired;
        const twice = good.length - fresh.length;
        setMessage({
          ok: true,
          text: [
            fresh.length ? `Loaded ${plural(fresh.length)}, checked against this server’s published keys.` : 'Nothing new was loaded.',
            twice ? `${twice === 1 ? 'That pass was' : `${plural(twice)} were`} already loaded.` : '',
            left ? `${plural(left)} had expired and ${left === 1 ? 'was' : 'were'} left out.` : '',
          ].filter(Boolean).join(' '),
        });
      }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof PassFileError ? e.message : `Could not check the passes with this server: ${(e as Error).message}` });
    } finally { setBusy(false); }
  }

  async function fromFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) { setMessage({ ok: false, text: 'This file is too big to be a pass file.' }); return; }
    await take(await file.text());
  }

  async function fromPhoto(file: File | undefined) {
    if (!file || !Reader) return;
    setMessage(null);
    try {
      const codes = await new Reader({ formats: ['qr_code'] }).detect(await createImageBitmap(file));
      if (!codes.length) { setMessage({ ok: false, text: 'No QR code was found in that photo. Try a sharper photo, or type the text.' }); return; }
      await take(codes.map((c) => c.rawValue).join('\n'));
    } catch {
      setMessage({ ok: false, text: 'This browser could not read the photo. Type or paste the text instead.' });
    }
  }

  return (
    <Section id="load" title={loaded ? 'Load more passes' : 'Load your passes'} description="Your passes come from your account’s Pen names page, saved to a file or printed. Nothing here signs you in.">
      <div className="space-y-2">
        <Label htmlFor="pass-file">The pass file</Label>
        <input id="pass-file" type="file" accept="application/json,.json" disabled={busy}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => { void fromFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="pass-text">Or paste or type a pass</Label>
        <textarea id="pass-text" rows={4} spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)}
          className="w-full rounded-md border bg-background p-2 font-mono text-xs" aria-describedby="pass-text-hint" placeholder="ofpass1~…" />
        <p id="pass-text-hint" className="text-xs text-muted-foreground">A pass starts with “ofpass1~” and is about 500 characters long; spaces and line breaks do not matter, and its checksum catches a typo. You can paste several.</p>
        <Button type="button" variant="outline" disabled={busy || !text.trim()} onClick={() => void take(text)}>{busy ? 'Checking…' : 'Load this pass'}</Button>
      </div>

      {Reader ? (
        <div className="space-y-2">
          <Label htmlFor="pass-photo">Or a photo of a printed pass</Label>
          <input id="pass-photo" type="file" accept="image/*" disabled={busy}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ''; }} />
          <p className="text-xs text-muted-foreground">The QR code is read on this device; the photo is not sent anywhere.</p>
        </div>
      ) : null}
      <Note>
        This page does not use the camera: the dashboard does not allow it. {Reader ? 'Take a photo of the QR code and load it above, or' : 'This browser cannot read QR codes from a photo either, so'} load the file or paste the text. A phone&apos;s camera or QR app can read a printed QR code into text you can copy. The file and the text are enough.
      </Note>

      {message && <StatusMessage ok={message.ok} text={message.text} />}
    </Section>
  );
}
