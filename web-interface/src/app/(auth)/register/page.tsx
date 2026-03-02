'use client';

import { useState } from 'react';
import Link from 'next/link';
import { registerAccount } from '@/lib/api/auth';
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

const ERROR_MESSAGES: Record<string, string> = {
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

    setLoading(true);
    const result = await registerAccount(handle, email, password, inviteCode || undefined);

    if (result.ok) {
      setSuccess(true);
    } else {
      setError(ERROR_MESSAGES[result.error] || result.message);
    }
    setLoading(false);
  };

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
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Registering...' : 'Register'}
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
