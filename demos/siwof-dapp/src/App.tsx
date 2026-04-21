import { useMemo, useState, type CSSProperties } from 'react';
import {
  createClient,
  verifySignInAssertion,
  type OpenFederationClient,
  type SiwofAssertResponse,
  type WalletChain,
  type VerifiedSignInAssertion,
} from '@open-federation/sdk';
import {
  OpenFederationProvider,
  SignInWithOpenFederation,
  useOFSession,
  useOFWallet,
} from '@open-federation/react';

/** Config surface — normally a dApp hard-codes these. The demo lets you edit them. */
interface DemoConfig {
  pdsUrl: string;
  partnerKey: string;
}

function LoginCard({ onReady }: { onReady: (config: DemoConfig) => void }) {
  const [pdsUrl, setPdsUrl] = useState('http://localhost:8080');
  const [partnerKey, setPartnerKey] = useState('');
  const disabled = !pdsUrl.trim() || !partnerKey.trim();

  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>1. Configure the SDK</h2>
      <p style={muted}>
        Connect to a running OpenFederation PDS. Any OpenFederation partner
        key works — the demo never creates a new account, only logs into an
        existing one.
      </p>
      <Label text="PDS URL">
        <input style={input} value={pdsUrl} onChange={(e) => setPdsUrl(e.target.value)} />
      </Label>
      <Label text="Partner key (ofp_…)">
        <input style={input} value={partnerKey} onChange={(e) => setPartnerKey(e.target.value)} />
      </Label>
      <button
        style={{ ...primaryButton, opacity: disabled ? 0.5 : 1 }}
        disabled={disabled}
        onClick={() => onReady({ pdsUrl: pdsUrl.trim(), partnerKey: partnerKey.trim() })}
      >
        Initialize client
      </button>
    </div>
  );
}

function Login() {
  const { login } = useOFSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    setError(null);
    setBusy(true);
    try {
      await login({ identifier, password });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={card}>
      <h2 style={{ marginTop: 0 }}>2. Log into OpenFederation</h2>
      <p style={muted}>Use any existing PDS account. Your wallets (if any) will appear below.</p>
      <Label text="Handle or email">
        <input style={input} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
      </Label>
      <Label text="Password">
        <input style={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Label>
      <button style={{ ...primaryButton, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={handleLogin}>
        {busy ? 'Logging in…' : 'Log in'}
      </button>
      {error && <p style={errorText}>{error}</p>}
    </div>
  );
}

function SiwofPanel() {
  const { user, client, logout } = useOFSession();
  const { wallets, refresh } = useOFWallet();
  const [chain, setChain] = useState<WalletChain>('ethereum');
  const [busy, setBusy] = useState(false);
  const [assertion, setAssertion] = useState<SiwofAssertResponse | null>(null);
  const [verified, setVerified] = useState<VerifiedSignInAssertion | null>(null);
  const [error, setError] = useState<string | null>(null);

  const walletOnChain = wallets.find((w) => w.chain === chain);

  async function provisionAndReady(): Promise<string> {
    // If there's no wallet on the chain, provision a Tier 1 custodial wallet
    // on demand. Grant consent for this dApp origin so wallet.sign works.
    let addr = walletOnChain?.walletAddress;
    if (!addr) {
      const prov = (await client.fetch('net.openfederation.wallet.provision', {
        method: 'POST',
        body: { chain, label: `demo-${chain}` },
      })) as { walletAddress: string };
      addr = prov.walletAddress;
      await refresh();
    }
    await client.wallet.grantConsent({
      dappOrigin: window.location.origin,
      chain,
      walletAddress: addr,
    });
    return addr;
  }

  async function handleSignInWithButton(): Promise<void> {
    setBusy(true);
    setError(null);
    setAssertion(null);
    setVerified(null);
    try {
      const addr = await provisionAndReady();
      const res = await client.signInWithOpenFederation({
        chain,
        walletAddress: addr,
        audience: window.location.origin,
        statement: 'Sign in to the SIWOF demo',
      });
      setAssertion(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOffline(): Promise<void> {
    if (!assertion) return;
    setError(null);
    try {
      const result = await verifySignInAssertion(assertion.didToken, assertion.walletProof, {
        expectedAudience: window.location.origin,
      });
      setVerified(result);
    } catch (err) {
      setError('Offline verify failed: ' + (err as Error).message);
    }
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>3. Sign in with OpenFederation</h2>
        <button style={ghostButton} onClick={() => logout()}>Log out</button>
      </div>
      <p style={muted}>
        Logged in as <strong>@{user?.handle}</strong> ({user?.did}).
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <label style={{ ...muted, fontWeight: 600 }}>
          Chain:
          <select
            style={{ ...input, marginLeft: 6, width: 'auto' }}
            value={chain}
            onChange={(e) => setChain(e.target.value as WalletChain)}
          >
            <option value="ethereum">Ethereum</option>
            <option value="solana">Solana</option>
          </select>
        </label>
        <span style={muted}>
          Wallet:{' '}
          {walletOnChain
            ? <code>{walletOnChain.walletAddress}</code>
            : <em>none yet — will be provisioned (Tier 1)</em>}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <button style={primaryButton} disabled={busy} onClick={handleSignInWithButton}>
          {busy ? 'Signing…' : 'Sign in with OpenFederation (programmatic)'}
        </button>
        <SignInWithOpenFederation
          chain={chain}
          audience={window.location.origin}
          statement="Sign in to the SIWOF demo"
          walletAddress={walletOnChain?.walletAddress}
          onSuccess={(a) => {
            setAssertion(a);
            setVerified(null);
            setError(null);
          }}
          onError={(e) => setError(e.message)}
          label="Sign in with OpenFederation (component)"
        />
      </div>

      {error && <p style={errorText}>{error}</p>}

      {assertion && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 4 }}>didToken claims</h3>
          <JsonView value={decodeJwtClaims(assertion.didToken)} />

          <h3 style={{ marginBottom: 4 }}>walletProof</h3>
          <JsonView value={assertion.walletProof} />

          <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'center' }}>
            <button style={primaryButton} onClick={handleVerifyOffline}>
              Verify offline
            </button>
            {verified && (
              <span style={{ color: '#0a7a3a', fontWeight: 600 }}>
                ✓ cryptographically verified — DID {verified.did}
              </span>
            )}
          </div>

          {verified && (
            <>
              <h3 style={{ marginBottom: 4, marginTop: 16 }}>Verifier output</h3>
              <JsonView value={verified} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Shell({ children, config, resetConfig }: { children: React.ReactNode; config: DemoConfig | null; resetConfig?: () => void }) {
  return (
    <div style={{ maxWidth: 780, margin: '2rem auto', padding: '0 1rem', fontFamily: "-apple-system, Segoe UI, system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Sign In With OpenFederation — demo dApp</h1>
        <p style={{ color: '#666', marginTop: 0 }}>
          A reference integration. Every piece runs through the same SDK a real
          dApp would ship.
        </p>
      </header>
      {config && resetConfig && (
        <div style={{ ...muted, marginBottom: 12 }}>
          Connected to <code>{config.pdsUrl}</code>{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); resetConfig(); }} style={{ marginLeft: 8 }}>change</a>
        </div>
      )}
      {children}
    </div>
  );
}

function AuthenticatedSurface() {
  const { ready, isAuthenticated } = useOFSession();
  if (!ready) return <div style={card}>Loading…</div>;
  if (!isAuthenticated) return <Login />;
  return <SiwofPanel />;
}

export function App() {
  const [config, setConfig] = useState<DemoConfig | null>(null);

  const client = useMemo<OpenFederationClient | null>(() => {
    if (!config) return null;
    return createClient({
      serverUrl: config.pdsUrl,
      partnerKey: config.partnerKey,
      storage: 'memory',
    });
  }, [config]);

  if (!config || !client) {
    return (
      <Shell config={null}>
        <LoginCard onReady={setConfig} />
      </Shell>
    );
  }

  return (
    <Shell config={config} resetConfig={() => setConfig(null)}>
      <OpenFederationProvider client={client}>
        <AuthenticatedSurface />
      </OpenFederationProvider>
    </Shell>
  );
}

// ─── util ───────────────────────────────────────────────────────────────────

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  try {
    const [, payloadB64] = jwt.split('.');
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded));
  } catch {
    return { _error: 'Could not decode JWT' };
  }
}

function JsonView({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        background: '#f6f6f6', padding: 12, borderRadius: 6, overflowX: 'auto',
        fontSize: 13, marginTop: 4,
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{text}</div>
      {children}
    </label>
  );
}

// ─── styles ─────────────────────────────────────────────────────────────────

const card: CSSProperties = {
  padding: '1.5rem', border: '1px solid #e5e5e5', borderRadius: 12,
  background: '#fff', marginBottom: 16,
};
const input: CSSProperties = {
  width: '100%', padding: '0.5rem', border: '1px solid #ccc',
  borderRadius: 6, fontSize: 14, boxSizing: 'border-box',
};
const primaryButton: CSSProperties = {
  padding: '0.625rem 1rem', border: 'none', borderRadius: 8,
  background: '#111', color: '#fff', fontWeight: 600, cursor: 'pointer',
};
const ghostButton: CSSProperties = {
  padding: '0.375rem 0.75rem', border: '1px solid #ccc', borderRadius: 6,
  background: 'transparent', cursor: 'pointer', fontSize: 13,
};
const muted: CSSProperties = { color: '#555', fontSize: 14 };
const errorText: CSSProperties = { color: '#b91c1c', marginTop: 12, fontSize: 14 };
