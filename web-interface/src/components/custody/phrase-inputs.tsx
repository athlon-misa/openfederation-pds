'use client';

import { useState } from 'react';
import { generateCustodyPhrase, normalizePhrase, unlockPhraseWithPasskey, type RememberedPhrase } from '@open-federation/sdk/custody';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { loadRemembered } from '@/lib/custody/custody';

/** A new phrase: shown once, then three of its words are asked back. */
export function NewPhrase({ onReady, intro, generate = generateCustodyPhrase, listLabel = 'Your 12 words' }: {
  onReady: (phrase: string) => void;
  /** What the words are for; by default, the identity phrase. */
  intro?: string;
  /** Makes the words; by default an identity phrase. */
  generate?: () => string;
  listLabel?: string;
}) {
  const [phrase] = useState(() => generate());
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
        <p className="text-sm">{intro ?? 'Write these 12 words on paper, in order, and keep the paper somewhere safe and private. Whoever has them controls your identity. This page will not show them again.'}</p>
        <p className="text-sm text-muted-foreground">Do not photograph them or keep them in email, chat or online notes.</p>
        <ol className="grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm sm:grid-cols-3" aria-label={listLabel}>
          {words.map((w, i) => <li key={i}><span className="text-muted-foreground">{i + 1}.</span> {w}</li>)}
        </ol>
        <Button type="button" onClick={() => setStage('check')}>I wrote them down</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm">To check your paper copy, type these words from it.</p>
      {asks.map((pos, i) => (
        <div key={pos} className="flex items-center gap-2">
          <Label htmlFor={`w${pos}`} className="w-20 shrink-0">Word {pos + 1}</Label>
          <Input id={`w${pos}`} autoComplete="off" value={answers[i]} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setStage('show')}>Show the words again</Button>
        <Button type="button" disabled={!ok} onClick={() => onReady(phrase)}>Continue</Button>
      </div>
    </div>
  );
}

/**
 * The phrase as typed or pasted. Numbering copied along with the words
 * ("1. apple 2. river") is dropped; anything else wrong is said, so the
 * Continue button is never disabled without a reason.
 */
function readPhrase(text: string): { phrase: string } | { problem: string | null } {
  const words = text.trim().toLowerCase().split(/\s+/).filter((w) => w && !/^\d+[.)]?$/.test(w));
  if (words.length === 0) return { problem: null };
  if (words.length !== 12) return { problem: `That is ${words.length} word${words.length === 1 ? '' : 's'}; 12 are needed.` };
  try {
    return { phrase: normalizePhrase(words.join(' ')) };
  } catch {
    return { problem: 'These 12 words are not a valid phrase. Check the spelling of each word, and that they are in order: 1 to 12, row by row as they were shown.' };
  }
}

/** Why a passkey unlock failed, in words that say what to do next. */
function unlockError(err: unknown): string {
  const name = err instanceof Error ? (err.name === 'Error' ? err.message : err.name) : String(err);
  console.warn('[custody] passkey unlock failed:', err);
  switch (name) {
    case 'NotAllowedError':
    case 'PasskeyCancelled':
      return 'The passkey prompt was cancelled or timed out. Try again, or type your 12 words instead.';
    case 'PasskeyPrfUnsupported':
      return 'This passkey cannot unlock saved words (its password manager does not support it). Type your 12 words instead.';
    case 'UnlockFailed':
      return 'This passkey did not open the words saved on this device. Type your 12 words instead.';
    default:
      return `The passkey could not unlock your words (${name}). Type them instead.`;
  }
}

/** The account's existing phrase: typed, or unlocked with the passkey remembered on this device. */
export function ExistingPhrase({ did, onReady }: { did: string; onReady: (phrase: string) => void }) {
  const remembered = loadRemembered(did) as RememberedPhrase | null;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const typed = readPhrase(text);
  return (
    <div className="space-y-3">
      {remembered && (
        <Button type="button" variant="outline" onClick={async () => {
          setError(null);
          try { onReady(await unlockPhraseWithPasskey(remembered)); } catch (err) { setError(unlockError(err)); }
        }}>Unlock with this device&apos;s passkey</Button>
      )}
      {remembered && (
        <p className="text-xs text-muted-foreground">Or type them:</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="existing-phrase">Your 12 words</Label>
        <Textarea id="existing-phrase" autoComplete="off" spellCheck={false} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {'problem' in typed && typed.problem && <p className="text-sm text-muted-foreground">{typed.problem}</p>}
      <Button type="button" disabled={!('phrase' in typed)} onClick={() => 'phrase' in typed && onReady(typed.phrase)}>Continue</Button>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

/** A 12-word phrase other than the identity phrase (the backup recovery phrase), typed or pasted. */
export function TypedPhrase({ id, label, action = 'Continue', onReady }: { id: string; label: string; action?: string; onReady: (phrase: string) => void }) {
  const [text, setText] = useState('');
  const typed = readPhrase(text);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Textarea id={id} autoComplete="off" spellCheck={false} className="font-mono" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {'problem' in typed && typed.problem && <p className="text-sm text-muted-foreground">{typed.problem}</p>}
      <Button type="button" disabled={!('phrase' in typed)} onClick={() => 'phrase' in typed && onReady(typed.phrase)}>{action}</Button>
    </div>
  );
}
