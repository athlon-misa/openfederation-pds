'use client';

import { useState } from 'react';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TypedPhrase } from '@/components/custody/phrase-inputs';
import { QrCode } from '@/components/custody/qr-code';
import { PasskeyOffer } from '@/components/account/passkey-offer';
import { loadPenPasskey, rememberPenWithPasskey, unlockPenWithPasskey } from '@/lib/pen-names/pen-names';
import { PEN_PASSKEY, PEN_PASSKEY_NOTE } from '@/lib/copy/glossary';

/** Why a passkey unlock failed, in words that say what to do next. */
export function passkeyProblem(err: unknown): string {
  const name = err instanceof Error ? (err.name === 'Error' ? err.message : err.name) : String(err);
  if (/NotAllowedError|PasskeyCancelled/.test(name)) return 'The passkey prompt was cancelled or timed out. Try again, or type the 12 words.';
  if (/PasskeyPrfUnsupported/.test(name)) return 'This passkey cannot unlock saved words (its password manager does not support it). Type the 12 words.';
  if (/UnlockFailed/.test(name)) return 'This passkey did not open the words saved on this device. Type the 12 words.';
  return `The passkey could not unlock the words (${name}). Type them instead.`;
}

/** A pen name's 12 words: unlocked with this device's passkey for it, or typed. */
export function PenWords({ penDid, id, label = 'The pen name’s 12 words', action = 'Continue', onReady }: {
  penDid?: string;
  id: string;
  label?: string;
  action?: string;
  onReady: (phrase: string) => void;
}) {
  const remembered = penDid ? loadPenPasskey(penDid) : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      {remembered && penDid && (
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={async () => {
            setError(null); setBusy(true);
            try { onReady(await unlockPenWithPasskey(penDid)); } catch (err) { setError(passkeyProblem(err)); } finally { setBusy(false); }
          }}>{busy ? 'Waiting for the passkey…' : 'Unlock with this device’s passkey'}</Button>
          <p className="text-xs text-muted-foreground">Or type them:</p>
        </>
      )}
      <TypedPhrase id={id} label={label} action={action} onReady={onReady} />
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

/** Offer to lock the pen name's words on this device with a passkey. */
export function PenPasskeyOffer({ penDid, phrase, onDone }: { penDid: string; phrase: string; onDone: (r: { ok: boolean; text: string } | null) => void }) {
  return (
    <div className="space-y-2">
      <PasskeyOffer
        did={penDid}
        handle="Pen name"
        phrase={phrase}
        heading="Unlock this pen name with a passkey on this device?"
        text={PEN_PASSKEY}
        remember={async () => { await rememberPenWithPasskey(penDid, phrase); }}
        doneText="This device will unlock the pen name's 12 words with its passkey. Keep the paper copy: the passkey is not a backup."
        onDone={onDone}
      />
      <p className="text-xs text-muted-foreground">{PEN_PASSKEY_NOTE}</p>
    </div>
  );
}

/** A link to /verify: shown, copyable, openable, and as a QR code for a phone. */
export function ShareLink({ link, label, qrLabel, file }: { link: string; label: string; qrLabel: string; file?: { name: string; json: unknown } }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="shrink-0 self-center rounded-md bg-white p-2 sm:self-start"><QrCode text={link} label={qrLabel} /></div>
        <div className="min-w-0 space-y-2">
          <p className="break-all rounded-md bg-muted/50 p-2 font-mono text-xs" aria-label="The link">{link}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={async () => {
              try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select the text instead */ }
            }}>{copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}{copied ? 'Copied' : 'Copy link'}</Button>
            <Button type="button" size="sm" variant="outline" asChild>
              <a href={link} target="_blank" rel="noreferrer"><ExternalLink className="size-4" aria-hidden />Open it</a>
            </Button>
            {file && (
              <Button type="button" size="sm" variant="outline" onClick={() => saveFile(new Blob([JSON.stringify(file.json, null, 2)], { type: 'application/json' }), file.name)}>
                <Download className="size-4" aria-hidden />Save as a file
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">The proof is in the part of the link after #, which browsers never send to a server. The page checks it on the device that opens it, against the public directory.</p>
        </div>
      </div>
    </div>
  );
}

/** Hand the browser a file to save. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A handle's file-name-safe form. */
export function fileSafe(handle: string): string {
  return handle.replace(/[^a-z0-9.-]+/gi, '-');
}
