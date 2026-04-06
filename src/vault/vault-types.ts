export interface VaultShare {
  id: string;
  userDid: string;
  shareIndex: number;
  shareHolder: 'device' | 'vault' | 'escrow';
  escrowProviderDid?: string;
  recoveryTier: number;
  createdAt: string;
}

export interface VaultAuditEntry {
  id: string;
  userDid: string;
  action: string;
  actorDid?: string;
  shareIndex?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
