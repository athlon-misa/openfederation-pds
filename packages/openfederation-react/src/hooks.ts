import { useCallback, useEffect, useState } from 'react';
import type {
  OpenFederationClient,
  User,
  LoginOptions,
  RegisterOptions,
  SignInWithOpenFederationOptions,
  SiwofAssertResponse,
  WalletLink,
} from '@openfederation/sdk';
import { useOpenFederationContext } from './provider.js';

export type { User, WalletLink };

/** Get the underlying OpenFederation SDK client directly. */
export function useOFClient(): OpenFederationClient {
  return useOpenFederationContext().client;
}

export interface OFSession {
  user: User | null;
  ready: boolean;
  isAuthenticated: boolean;
  client: OpenFederationClient;
  login: (opts: LoginOptions) => Promise<User>;
  register: (opts: RegisterOptions) => Promise<User>;
  logout: () => Promise<void>;
}

/**
 * Primary hook for reading auth state and kicking off login / register /
 * logout. Re-renders automatically when the SDK's auth state changes.
 *
 * @example
 * ```tsx
 * const { user, login, logout, isAuthenticated } = useOFSession();
 * if (!isAuthenticated) return <LoginForm onSubmit={login} />;
 * return <div>Welcome, @{user.handle} <button onClick={logout}>Sign out</button></div>;
 * ```
 */
export function useOFSession(): OFSession {
  const { client, user, ready } = useOpenFederationContext();

  const login = useCallback((opts: LoginOptions) => client.login(opts), [client]);
  const register = useCallback((opts: RegisterOptions) => client.register(opts), [client]);
  const logout = useCallback(() => client.logout(), [client]);

  return {
    user,
    ready,
    isAuthenticated: user !== null,
    client,
    login,
    register,
    logout,
  };
}

export interface OFWallets {
  wallets: WalletLink[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /**
   * Convenience wrapper for client.signInWithOpenFederation — runs the
   * full SIWOF flow and returns the assertion the dApp needs.
   */
  signIn: (opts: SignInWithOpenFederationOptions) => Promise<SiwofAssertResponse>;
}

/**
 * Hook for reading the current user's wallet portfolio and issuing SIWOF
 * assertions from React components.
 *
 * @example
 * ```tsx
 * const { wallets, signIn } = useOFWallet();
 *
 * async function handleSignIn() {
 *   const eth = wallets.find(w => w.chain === 'ethereum');
 *   if (!eth) return;
 *   const assertion = await signIn({
 *     chain: 'ethereum',
 *     walletAddress: eth.walletAddress,
 *     audience: window.location.origin,
 *   });
 *   // POST assertion.didToken + assertion.walletProof to your backend.
 * }
 * ```
 */
export function useOFWallet(): OFWallets {
  const { client, user } = useOpenFederationContext();
  const [wallets, setWallets] = useState<WalletLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setWallets([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await client.listWalletLinks();
      setWallets(res.walletLinks);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [client, user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = useCallback(
    (opts: SignInWithOpenFederationOptions) => client.signInWithOpenFederation(opts),
    [client]
  );

  return { wallets, loading, error, refresh, signIn };
}
