'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { registerAccount } from '@/lib/api/auth';
import { MODE_TEXT, identityPolicy, registerWithOwnKeys, type CustodyMode } from '@/lib/custody/custody';
import { NewPhrase } from '@/components/custody/phrase-inputs';
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

const THIS_PDS = process.env.NEXT_PUBLIC_PDS_URL || 'http://localhost:3000';

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
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Custody modes this server offers (ADR-003). Only shown when there is a choice.
  const [modes, setModes] = useState<CustodyMode[]>(['custodial']);
  const [mode, setMode] = useState<CustodyMode>('custodial');
  const [choosingPhrase, setChoosingPhrase] = useState(false);
  // Kept after a failed attempt: the person already wrote it down.
  const [phrase, setPhrase] = useState<string | null>(null);
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
      await registerWithOwnKeys({ pdsUrl: THIS_PDS, mode: mode as 'assisted' | 'self', phrase: chosen, handle, email, password, inviteCode: inviteCode || undefined });
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
          <CardDescription>{MODE_TEXT[mode].what}</CardDescription>
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
          <CardTitle className="text-2xl">Registration submitted</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your account has been created and is pending admin approval.
            You will be able to sign in once an administrator approves your account.
          </p>
        </CardContent>
        <CardFooter>
          <Link href="/login" className="w-full">
            <Button variant="outline" className="w-full">
              Back to sign in
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
              <legend className="text-sm font-medium">Who holds the key to your identity</legend>
              {modes.map((m) => (
                <label key={m} className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${mode === m ? 'border-primary bg-muted ring-2 ring-primary' : 'opacity-80'}`}>
                  <input type="radio" name="custody" value={m} checked={mode === m} onChange={() => { setMode(m); setPhrase(null); }} className="mt-1" />
                  <span><span className="font-medium">{MODE_TEXT[m].title}</span>{mode === m && <span className="ml-2 text-xs font-medium text-primary">Selected</span>}<span className="block text-muted-foreground">{MODE_TEXT[m].what}</span></span>
                </label>
              ))}
            </fieldset>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Registering...' : modes.length > 1 ? `Register (${MODE_TEXT[mode].title})` : 'Register'}
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
