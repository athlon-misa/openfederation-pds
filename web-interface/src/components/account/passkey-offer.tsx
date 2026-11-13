'use client';

import { useState } from 'react';
import { rememberPhraseWithPasskey } from '@open-federation/sdk/custody';
import { Button } from '@/components/ui/button';
import { saveRemembered } from '@/lib/custody/custody';
import { PASSKEY } from '@/lib/copy/glossary';
import { ChoiceExplainer, StatusMessage } from './explain';

/**
 * After the person has typed or written down their 12 words: offer to keep
 * them on this device behind a passkey (ADR-003 decision 12).
 */
export function PasskeyOffer({ did, handle, phrase, onDone, heading = 'Use a passkey on this device?' }: {
  did: string;
  handle: string;
  phrase: string;
  onDone: (result: { ok: boolean; text: string } | null) => void;
  heading?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">{heading}</h3>
      <p className="text-sm">{PASSKEY.summary}</p>
      <ChoiceExplainer text={PASSKEY} />
      {error && <StatusMessage ok={false} text={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            saveRemembered(did, await rememberPhraseWithPasskey({ phrase, rpName: 'OpenFederation', userName: handle }));
            onDone({ ok: true, text: 'This device will unlock your 12 words with its passkey. Keep your paper copy.' });
          } catch {
            setError('This browser or device cannot do it (it needs a passkey that supports unlocking data). Keep typing your 12 words.');
          } finally { setBusy(false); }
        }}>{busy ? 'Waiting for the passkey…' : 'Use a passkey on this device'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => onDone(null)}>Not now</Button>
      </div>
    </div>
  );
}
