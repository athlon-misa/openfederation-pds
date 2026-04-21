import React, { useCallback, useState } from 'react';
import type {
  SiwofAssertResponse,
  WalletChain,
} from '@openfederation/sdk';
import { useOpenFederationContext } from './provider.js';

export interface SignInWithOpenFederationProps {
  /** Chain to sign in with. */
  chain: WalletChain;
  /**
   * Wallet address to sign the SIWOF message with. If omitted, the user's
   * primary wallet for the chain is used (looked up via listWalletLinks).
   */
  walletAddress?: string;
  /**
   * Full audience URL (your dApp). Defaults to `window.location.origin`.
   */
  audience?: string;
  /** Optional prompt rendered inside the CAIP-122 message. */
  statement?: string;
  /** Callback invoked with the offline-verifiable assertion on success. */
  onSuccess: (assertion: SiwofAssertResponse) => void;
  /** Callback invoked with any error from the sign-in attempt. */
  onError?: (error: Error) => void;
  /** Customize the button label. Defaults to "Sign in with OpenFederation". */
  label?: React.ReactNode;
  /** Replace the default button with a render-prop for full control. */
  render?: (props: {
    onClick: () => void;
    loading: boolean;
    disabled: boolean;
  }) => React.ReactElement;
  /** Optional extra classes for the default button. */
  className?: string;
  /** Optional inline styles for the default button. */
  style?: React.CSSProperties;
}

const DEFAULT_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '0.625rem 1rem',
  border: '1px solid rgba(0,0,0,0.1)',
  borderRadius: '0.5rem',
  background: '#111',
  color: '#fff',
  fontWeight: 600,
  cursor: 'pointer',
};

/**
 * Drop-in button that runs the full Sign-In With OpenFederation flow.
 *
 * @example
 * ```tsx
 * <SignInWithOpenFederation
 *   chain="ethereum"
 *   audience={window.location.origin}
 *   onSuccess={(assertion) => {
 *     fetch('/api/login', { method: 'POST', body: JSON.stringify(assertion) });
 *   }}
 * />
 * ```
 */
export function SignInWithOpenFederation(props: SignInWithOpenFederationProps): React.ReactElement {
  const { client, user } = useOpenFederationContext();
  const [loading, setLoading] = useState(false);

  const disabled = !user || loading;

  const handleClick = useCallback(async () => {
    if (disabled) return;
    setLoading(true);
    try {
      // Resolve wallet address if omitted.
      let walletAddress = props.walletAddress;
      if (!walletAddress) {
        const list = await client.listWalletLinks();
        const primaryOnChain = list.walletLinks.find(
          (w) => w.chain === props.chain
        );
        if (!primaryOnChain) {
          throw new Error(
            `No wallet found on chain "${props.chain}" for this account. Provision or link one first.`
          );
        }
        walletAddress = primaryOnChain.walletAddress;
      }

      const audience = props.audience
        ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
      if (!audience) {
        throw new Error('audience is required (no window.location available)');
      }

      const assertion = await client.signInWithOpenFederation({
        chain: props.chain,
        walletAddress,
        audience,
        statement: props.statement,
      });
      props.onSuccess(assertion);
    } catch (err) {
      if (props.onError) props.onError(err as Error);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, [client, disabled, props]);

  if (props.render) {
    return props.render({ onClick: handleClick, loading, disabled });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={props.className}
      style={{ ...DEFAULT_STYLE, opacity: disabled ? 0.6 : 1, ...(props.style ?? {}) }}
      data-openfederation-signin
    >
      {loading
        ? 'Signing…'
        : (props.label ?? 'Sign in with OpenFederation')}
    </button>
  );
}
