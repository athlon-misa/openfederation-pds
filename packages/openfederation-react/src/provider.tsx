import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import type { OpenFederationClient, User } from '@openfederation/sdk';

export interface OpenFederationProviderProps {
  /** A client instance created via `createClient(...)` from @openfederation/sdk. */
  client: OpenFederationClient;
  children: React.ReactNode;
}

interface OpenFederationContextValue {
  client: OpenFederationClient;
  user: User | null;
  ready: boolean;
}

const OpenFederationContext = createContext<OpenFederationContextValue | null>(null);

/**
 * Wrap your React tree in this. The provider subscribes to the SDK's auth
 * state and exposes the current user through `useOFSession()`.
 *
 * @example
 * ```tsx
 * import { createClient } from '@openfederation/sdk';
 * import { OpenFederationProvider } from '@openfederation/react';
 *
 * const client = createClient({ serverUrl, partnerKey });
 *
 * <OpenFederationProvider client={client}>
 *   <App />
 * </OpenFederationProvider>
 * ```
 */
export function OpenFederationProvider({ client, children }: OpenFederationProviderProps): React.ReactElement {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const u = await client.getUser();
      if (!mounted) return;
      setUser(u);
      setReady(true);
    })();
    const unsubscribe = client.onAuthChange((u) => {
      if (mounted) setUser(u);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [client]);

  const value = useMemo(() => ({ client, user, ready }), [client, user, ready]);
  return (
    <OpenFederationContext.Provider value={value}>
      {children}
    </OpenFederationContext.Provider>
  );
}

/** Internal — use the public hooks from `./hooks.ts` instead. */
export function useOpenFederationContext(): OpenFederationContextValue {
  const ctx = useContext(OpenFederationContext);
  if (!ctx) {
    throw new Error(
      'OpenFederation hooks/components must be used inside <OpenFederationProvider>. ' +
      'Wrap your app root with it.'
    );
  }
  return ctx;
}
