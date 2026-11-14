'use client';

/**
 * Public verifier: no login. Opened from a QR code (the stage demo's In
 * person and Reveal screens), it checks the proof in the link's #fragment on
 * this device against the public PLC directory. The fragment never reaches a
 * server; the page only reads the directory.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { verifyLink, type LinkVerdict } from '@open-federation/pseudonym';
import { verifierPlcUrl } from '@/lib/verify/plc';
import { IN_PERSON_CONTEXT, presenceContextOf } from '@/lib/verify/presence-context';

type State =
  | { phase: 'empty' }
  | { phase: 'checking' }
  | { phase: 'done'; verdict: LinkVerdict; plcUrl: string; context: string }
  | { phase: 'broken'; message: string };

/** A failed check, in plain words. */
const FAILED: Record<string, string> = {
  statement: 'The proof’s sentence doesn’t name these two accounts.',
  genesisHash: 'The pen name’s public entry is not the one in the directory.',
  genesisSignature: 'The pen name’s public entry is not genuine.',
  pseudonymSignature: 'The pen name’s twelve words did not sign this.',
  commitment: 'The sealed note in the pen name’s entry doesn’t name this account.',
  ownerSignature: 'The owner’s key did not sign this.',
  ownerKeyCurrent: 'The key that signed is not the one the owner’s public entry names.',
};

const host = (url: string) => url.replace(/^https?:\/\//, '');
const shortDid = (did: string) => `${did.slice(0, 14)}…${did.slice(-6)}`;

function Who({ handle, did }: { handle?: string; did: string }) {
  return <span className="font-medium">{handle ?? shortDid(did)}</span>;
}

function Verdict({ verdict, plcUrl, context }: { verdict: LinkVerdict; plcUrl: string; context: string }) {
  const ok = verdict.valid;
  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-3 rounded-lg p-4 ${ok ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
        {ok ? <CheckCircle2 className="size-8 shrink-0" aria-hidden /> : <XCircle className="size-8 shrink-0" aria-hidden />}
        <span className="text-3xl font-bold tracking-wide">{ok ? 'VALID' : 'INVALID'}</span>
      </div>

      {verdict.kind === 'presence' ? (
        <div className="space-y-2">
          <p className="text-base leading-relaxed">
            {ok ? (
              <>The word “{verdict.word}” was signed with the twelve words that control <Who handle={verdict.pseudonymHandle} did={verdict.pseudonymDid} />.
                Whoever signed it holds them.</>
            ) : (
              <>This signature of “{verdict.word}” does not match <Who handle={verdict.pseudonymHandle} did={verdict.pseudonymDid} />.
                {verdict.error ? ` (${verdict.error})` : ''}</>
            )}
          </p>
          {context !== IN_PERSON_CONTEXT && (
            <p className="text-sm text-muted-foreground">Signed for: “{context}”.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-base leading-relaxed">
          {ok ? (
            <p><Who handle={verdict.pseudonymHandle} did={verdict.pseudonymDid} /> belongs to <Who handle={verdict.ownerHandle} did={verdict.ownerDid} />.</p>
          ) : (
            <p>This does not prove that <Who handle={verdict.pseudonymHandle} did={verdict.pseudonymDid} /> belongs to <Who handle={verdict.ownerHandle} did={verdict.ownerDid} />.
              {verdict.error ? ` (${verdict.error})` : ''}</p>
          )}
          {ok && verdict.ownerAttestation === 'person' && (
            <p className="rounded-md border p-3 text-sm">
              <span className="font-medium">Signed by the person.</span> The owner’s half was signed with a key only they hold, from their own twelve words. Their server could not have made it.
            </p>
          )}
          {ok && verdict.ownerAttestation === 'pds-held-key' && (
            <p className="rounded-md border p-3 text-sm">
              <span className="font-medium">Signed by the server’s key.</span> The owner’s half was signed by the key their server holds for them. It shows the account agreed, as far as their server can say; it is not a key only the person holds.
            </p>
          )}
          {!ok && verdict.checks.length > 0 && (
            <ul className="space-y-1 text-sm">
              {[...new Set(verdict.checks.filter((c) => !c.ok).map((c) => FAILED[c.name] ?? c.detail ?? c.name))]
                .map((text) => <li key={text}>✗ {text}</li>)}
            </ul>
          )}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Checked on this device against the public directory at {host(plcUrl)}. Nothing went through the presenter’s laptop.
      </p>
    </div>
  );
}

export default function VerifyPage() {
  const [state, setState] = useState<State>({ phase: 'empty' });

  const check = useCallback(async () => {
    const fragment = window.location.hash.replace(/^#/, '');
    if (!fragment) { setState({ phase: 'empty' }); return; }
    setState({ phase: 'checking' });
    try {
      // An in-person proof's word is checked in the context its link names (c=); a link without one, in the stage demo's.
      const context = presenceContextOf(fragment);
      const plcUrl = await verifierPlcUrl(window.location.search);
      setState({ phase: 'done', verdict: await verifyLink(fragment, { plcUrl, presenceContext: context }), plcUrl, context });
    } catch (err) {
      setState({ phase: 'broken', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    // Read the fragment after mount: it exists only in the browser.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [check]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Check it yourself</CardTitle>
        <CardDescription>
          This page checks a proof on your own phone, against the public directory every OpenFederation server uses.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.phase === 'empty' && (
          <p className="text-sm text-muted-foreground">Scan the code on the screen to open a proof here.</p>
        )}
        {state.phase === 'checking' && (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden /> Checking against the public directory…</p>
        )}
        {state.phase === 'broken' && (
          <p className="text-sm text-destructive">This link is not a proof this page can read ({state.message}).</p>
        )}
        {state.phase === 'done' && <Verdict verdict={state.verdict} plcUrl={state.plcUrl} context={state.context} />}
      </CardContent>
    </Card>
  );
}
