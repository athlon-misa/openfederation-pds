'use client';

import { useState } from 'react';
import { generateCustodyPhrase, normalizePhrase, unlockPhraseWithPasskey, type RememberedPhrase } from '@open-federation/sdk/custody';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { loadRemembered } from '@/lib/custody/custody';

/** A new phrase: shown once, then three of its words are asked back. */
export function NewPhrase({ onReady }: { onReady: (phrase: string) => void }) {
  const [phrase] = useState(() => generateCustodyPhrase());
  const words = phrase.split(' ');
  const [stage, setStage] = useState<'show' | 'check'>('show');
  // Three different positions, chosen once.
  const [asks] = useState(() => {
    const picked = new Set<number>();
    const rnd = new Uint32Array(1);
    while (picked.size < 3) { crypto.getRandomValues(rnd); picked.add(rnd[0] % 12); }
    return [...picked].sort((a, b) => a - b);
  });
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const ok = asks.every((pos, i) => answers[i].trim().toLowerCase() === words[pos]);

  if (stage === 'show') {
    return (
      <div className="space-y-3">
        <p className="text-sm">Write these 12 words on paper, in order, and keep them safe. They are the key to your identity; this page will not show them again.</p>
        <ol className="grid grid-cols-3 gap-2 rounded-md border p-3 font-mono text-sm" aria-label="Your 12 words">
          {words.map((w, i) => <li key={i}><span className="text-muted-foreground">{i + 1}.</span> {w}</li>)}
        </ol>
        <Button type="button" onClick={() => setStage('check')}>I wrote them down</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">Check: type these words from your paper.</p>
      {asks.map((pos, i) => (
        <div key={pos} className="flex items-center gap-2">
          <Label htmlFor={`w${pos}`} className="w-16">Word {pos + 1}</Label>
          <Input id={`w${pos}`} autoComplete="off" value={answers[i]} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => setStage('show')}>Show the words again</Button>
        <Button type="button" disabled={!ok} onClick={() => onReady(phrase)}>Continue</Button>
      </div>
    </div>
  );
}

/** The account's existing phrase: typed, or unlocked with the passkey remembered on this device. */
export function ExistingPhrase({ did, onReady }: { did: string; onReady: (phrase: string) => void }) {
  const remembered = loadRemembered(did) as RememberedPhrase | null;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  let valid = false;
  try { normalizePhrase(text); valid = true; } catch { valid = false; }
  return (
    <div className="space-y-3">
      {remembered && (
        <Button type="button" variant="outline" onClick={async () => {
          setError(null);
          try { onReady(await unlockPhraseWithPasskey(remembered)); } catch { setError('The passkey could not unlock the phrase. Type it instead.'); }
        }}>Unlock with this device&apos;s passkey</Button>
      )}
      <div className="space-y-2">
        <Label htmlFor="existing-phrase">Your 12 words</Label>
        <Textarea id="existing-phrase" autoComplete="off" spellCheck={false} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <Button type="button" disabled={!valid} onClick={() => onReady(normalizePhrase(text))}>Continue</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
