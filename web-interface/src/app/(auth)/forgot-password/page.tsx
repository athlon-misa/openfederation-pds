'use client';

import { useState } from 'react';
import Link from 'next/link';
import { requestPasswordReset } from '@/lib/api/account';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await requestPasswordReset(identifier.trim());
    // The server answers the same whether or not the account exists, so the
    // page does too: only a failed request (network, rate limit) is shown.
    if (result.ok) setSent(true);
    else setError(result.message);
    setLoading(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Reset your password</CardTitle>
        <CardDescription>We&apos;ll email you a link to choose a new one.</CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">What a reset gives you back</summary>
          <p className="mt-2 text-muted-foreground">
            Your login, and nothing else. If your account is Assisted or Self, a reset never restores your 12 words or control of your identity:
            for that you need your 12 words, your recovery, or (Assisted only) this server&apos;s operator.
          </p>
          <Link href="/glossary#password-reset" className="mt-1 inline-block text-xs underline underline-offset-4 hover:no-underline">More in the glossary</Link>
        </details>
      </CardContent>
      {sent ? (
        <CardContent className="space-y-4">
          <p className="text-sm">
            If an account here uses that handle or email, a reset link is on its way. It works for 60 minutes.
            Check your spam folder if it hasn&apos;t arrived in a few minutes.
          </p>
          <Link href="/login" className="text-sm text-primary underline hover:no-underline">Back to sign in</Link>
        </CardContent>
      ) : (
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="identifier">Handle or email</Label>
              <Input
                id="identifier"
                type="text"
                placeholder="your-handle or email@example.com"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Sending…' : 'Email me a reset link'}
            </Button>
            <Link href="/login" className="text-sm text-muted-foreground underline hover:no-underline">Back to sign in</Link>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
