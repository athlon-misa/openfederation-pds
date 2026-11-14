'use client';

import { useState } from 'react';
import { rememberPhraseWithPasskey } from '@open-federation/sdk/custody';
import { Button } from '@/components/ui/button';
import { saveRemembered } from '@/lib/custody/custody';
import { PASSKEY, type ChoiceText } from '@/lib/copy/glossary';
import { ChoiceExplainer, StatusMessage } from './explain';

/**
 * After the person has typed or written down their 12 words: offer to keep
 * them on this device behind a passkey (ADR-003 decision 12).
 */
export function PasskeyOffer({ did, handle, phrase, onDone, heading = 'Use a passkey on this device?', remember, doneText, text = PASSKEY }: {
  did: string;
  handle: string;
  phrase: string;
  onDone: (result: { ok: boolean; text: string } | null) => void;
  heading?: string;
  /** Stores the words some other way (a pen name's); by default, as this account's identity words. */
  remember?: () => Promise<void>;
  doneText?: string;
  /** The four answers; by default, for the identity words. */
  text?: ChoiceText;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">{heading}</h3>
      <p className="text-sm">{text.summary}</p>
      <ChoiceExplainer text={text} />
      {error && <StatusMessage ok={false} text={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            if (remember) await remember();
            else saveRemembered(did, await rememberPhraseWithPasskey({ phrase, rpName: 'OpenFederation', userName: handle }));
            onDone({ ok: true, text: doneText ?? 'This device will unlock your 12 words with its passkey. Keep your paper copy.' });
          } catch {
            setError(`This browser or device cannot do it (it needs a passkey that supports unlocking data). Keep typing ${remember ? 'the' : 'your'} 12 words.`);
          } finally { setBusy(false); }
        }}>{busy ? 'Waiting for the passkey…' : 'Use a passkey on this device'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onDone(null)}>Not now</Button>
      </div>
    </div>
  );
}
