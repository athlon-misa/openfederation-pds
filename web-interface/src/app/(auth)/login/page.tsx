'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth-store';
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

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [externalHandle, setExternalHandle] = useState('');
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState('');
  const login = useAuthStore((s) => s.login);
  const externalLogin = useAuthStore((s) => s.externalLogin);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(identifier, password);

    if (result.ok) {
      router.push('/communities');
    } else {
      if (result.error === 'AccountNotApproved') {
        setError('Your account is pending admin approval.');
      } else if (result.error === 'Unauthorized') {
        setError('Invalid credentials. Please check your handle/email and password.');
      } else {
        setError(result.message);
      }
    }
    setLoading(false);
  };

  const handleExternalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setExternalError('');
    setExternalLoading(true);

    const result = await externalLogin(externalHandle);

    if (result.ok) {
      // Redirect to the remote PDS for authentication
      window.location.href = result.redirectUrl;
    } else {
      setExternalError(result.message);
    }
    setExternalLoading(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Sign in to your OpenFederation account
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
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
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
          <p className="text-sm text-muted-foreground">
            Don&apos;t have an account?{' '}
            <Link href="/register" className="text-primary underline hover:no-underline">
              Register
            </Link>
          </p>
        </CardFooter>
      </form>

      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">
            Or sign in with ATProto
          </span>
        </div>
      </div>

      <form onSubmit={handleExternalLogin}>
        <CardContent className="space-y-4 pt-0">
          {externalError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {externalError}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="externalHandle">ATProto handle</Label>
            <Input
              id="externalHandle"
              type="text"
              placeholder="alice.bsky.social"
              value={externalHandle}
              onChange={(e) => setExternalHandle(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Sign in with your existing Bluesky or ATProto account
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" variant="outline" className="w-full" disabled={externalLoading}>
            {externalLoading ? 'Redirecting...' : 'Sign in with ATProto'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
