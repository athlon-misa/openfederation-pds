'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { registerAccount } from '@/lib/api/auth';
import { identityPolicy, registerWithOwnKeys, type CustodyMode } from '@/lib/custody/custody';
import { CUSTODY, POSTING_KEY_NOTE, switchAck } from '@/lib/copy/glossary';
import { NewPhrase } from '@/components/custody/phrase-inputs';
import { Acknowledge, ChoiceExplainer } from '@/components/account/explain';
import { isValidHandle, isValidEmail, isStrongPassword, passwordValidationMessage } from '@/lib/validators';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { THIS_PDS } from '@/lib/this-pds';

const ERROR_MESSAGES: Record<string, string> = {
  CustodyModeNotAllowed: 'This server does not allow that kind of account.',
  AccountExists: 'An account with this handle or email already exists.',
  InviteRequired: 'An invite code is required to register.',
  InviteInvalid: 'The invite code is invalid.',
  InviteExpired: 'The invite code has expired.',
  InviteUsed: 'The invite code has already been used.',
};

export default function RegisterPage() {
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // /register?invite=CODE (e.g. from an imported community's invite list) fills the code in.
  const searchParams = useSearchParams();
  const [inviteCode, setInviteCode] = useState(() => (searchParams?.get('invite') ?? '').slice(0, 64));
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // The server may approve new accounts automatically: then there is nothing to wait for.
  const [approved, setApproved] = useState(false);
  // Custody modes this server offers (ADR-003). Only shown when there is a choice.
  const [modes, setModes] = useState<CustodyMode[]>(['custodial']);
  const [mode, setMode] = useState<CustodyMode>('custodial');
  const [choosingPhrase, setChoosingPhrase] = useState(false);
  // Assisted and Self: the person confirms they understood before the words are made.
  const [ack, setAck] = useState(false);
  // Kept after a failed attempt: the person already wrote it down.
  const [phrase, setPhrase] = useState<string | null>(null);
  // An invite link (`/register?invite=CODE`, e.g. from `ofc community import
  // discord --invites`) fills in the code.
  useEffect(() => {
    let alive = true;
    void identityPolicy(THIS_PDS).then((policy) => {
      if (!alive || !policy) return;
      setModes(policy.custodyAllowed);
      setMode(policy.custodyDefault);
    });
    return () => { alive = false; };
  }, []);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!isValidHandle(handle)) {
      errors.handle = 'Handle must be 3-30 characters: lowercase letters, numbers, hyphens.';
    }
    if (!isValidEmail(email)) {
      errors.email = 'Please enter a valid email address.';
    }
    if (!isStrongPassword(password)) {
      errors.password = passwordValidationMessage();
    }
    if (!inviteCode.trim()) {
      errors.inviteCode = 'An invite code is required to register.';
    }
    if (mode !== 'custodial' && !ack) {
      errors.ack = 'Confirm that you understand what this choice means.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!validate()) return;

    if (mode !== 'custodial') {
      if (phrase) { void finishWithPhrase(phrase); return; } // a retry: same phrase
      setChoosingPhrase(true); // the phrase first; registration follows in finishWithPhrase
      return;
    }
    setLoading(true);
    const result = await registerAccount(handle, email, password, inviteCode || undefined);

    if (result.ok) {
      setApproved(result.data.status === 'approved');
      setSuccess(true);
    } else {
      setError(ERROR_MESSAGES[result.error] || result.message);
    }
    setLoading(false);
  };

  async function finishWithPhrase(chosen: string) {
    setPhrase(chosen);
    setLoading(true);
    setError('');
    try {
      const done = await registerWithOwnKeys({ pdsUrl: THIS_PDS, mode: mode as 'assisted' | 'self', phrase: chosen, handle, email, password, inviteCode: inviteCode || undefined });
      setApproved(done.status === 'approved');
      setSuccess(true);
    } catch (e) {
      const err = e as Error & { code?: string };
      setError((err.code && ERROR_MESSAGES[err.code]) || err.message);
      setChoosingPhrase(false);
    }
    setLoading(false);
  }

  if (choosingPhrase && !success) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Your 12 words</CardTitle>
          <CardDescription>{CUSTODY[mode].means}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? <p className="text-sm">Creating your identity…</p> : <NewPhrase onReady={finishWithPhrase} />}
          {!loading && <Button type="button" variant="ghost" onClick={() => setChoosingPhrase(false)}>Back</Button>}
        </CardContent>
      </Card>
    );
  }

  if (success) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{approved ? 'Your account is ready' : 'Registration submitted'}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {approved
              ? 'Your account has been created and approved. You can sign in now.'
              : 'Your account has been created and is pending admin approval. You will be able to sign in once an administrator approves your account.'}
          </p>
        </CardContent>
        <CardFooter>
          <Link href="/login" className="w-full">
            <Button variant={approved ? 'default' : 'outline'} className="w-full">
              {approved ? 'Sign in' : 'Back to sign in'}
            </Button>
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Create an account</CardTitle>
        <CardDescription>Register for an OpenFederation account</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="handle">Handle</Label>
            <Input
              id="handle"
              type="text"
              placeholder="your-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase())}
              required
            />
            {fieldErrors.handle && (
              <p className="text-xs text-destructive">{fieldErrors.handle}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            {fieldErrors.email && (
              <p className="text-xs text-destructive">{fieldErrors.email}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              10-128 characters, must include at least 3 of: lowercase, uppercase, digit, special character.
            </p>
            {fieldErrors.password && (
              <p className="text-xs text-destructive">{fieldErrors.password}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="inviteCode">Invite code</Label>
            <Input
              id="inviteCode"
              type="text"
              placeholder="abc123"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
            />
            {fieldErrors.inviteCode && (
              <p className="text-xs text-destructive">{fieldErrors.inviteCode}</p>
            )}
          </div>
          {modes.length > 1 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Who controls your identity</legend>
              <p className="text-xs text-muted-foreground">
                Your identity is your permanent ID on the network. Whoever holds its keys can change it or move it.{' '}
                <Link href="/glossary#compare-modes" className="underline underline-offset-4 hover:no-underline" target="_blank">Compare the options in the glossary</Link>
              </p>
              {modes.map((m) => (
                <label key={m} className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm focus-within:ring-[3px] focus-within:ring-ring/50 ${mode === m ? 'border-primary bg-muted ring-2 ring-primary' : ''}`}>
                  <input type="radio" name="custody" value={m} checked={mode === m} onChange={() => { setMode(m); setPhrase(null); setAck(false); }} className="mt-1" />
                  <span><span className="font-medium">{CUSTODY[m].title}</span>{mode === m && <span className="ml-2 text-xs font-medium">(selected)</span>}<span className="block text-muted-foreground">{CUSTODY[m].summary}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          {(modes.length > 1 || mode !== 'custodial') && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{CUSTODY[mode].title}, before you choose</p>
                <ChoiceExplainer text={CUSTODY[mode]} className="[&>div]:!block" />
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">True in every mode</summary>
                  <p className="mt-1">{POSTING_KEY_NOTE}</p>
                </details>
                {mode !== 'custodial' && (
                  <Acknowledge id="register-ack" text={switchAck(mode)} checked={ack} onChange={setAck} />
                )}
                {fieldErrors.ack && <p className="text-xs text-destructive">{fieldErrors.ack}</p>}
              </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Registering...' : modes.length > 1 ? `Register (${CUSTODY[mode].title})` : 'Register'}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-primary underline hover:no-underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
