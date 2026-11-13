'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function CallbackPage() {
  const [callbackError, setCallbackError] = useState('');
  const handleCallback = useAuthStore((s) => s.handleCallback);
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams?.get('code') ?? null;
  const errorParam = searchParams?.get('error') ?? null;

  // What the URL already says is known on render; only the code exchange
  // happens in the effect, and only its result is stored.
  const urlError = errorParam
    ? 'Authentication failed. Please try again.'
    : !code ? 'Missing authentication code.' : '';
  const error = urlError || callbackError;
  const loading = !error;

  useEffect(() => {
    if (!code || errorParam) return;
    let alive = true;
    handleCallback(code).then((result) => {
      if (!alive) return;
      if (result.ok) router.push('/communities');
      else setCallbackError(result.message);
    });
    return () => { alive = false; };
  }, [code, errorParam, handleCallback, router]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Signing in...</CardTitle>
          <CardDescription>
            Completing ATProto authentication
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Authentication failed</CardTitle>
        <CardDescription>
          There was a problem signing in with ATProto
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => router.push('/login')}
        >
          Back to login
        </Button>
      </CardContent>
    </Card>
  );
}
