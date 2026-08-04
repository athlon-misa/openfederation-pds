-- Cache identity must include every constraint that changes verification.
ALTER TABLE proof_verifications DROP CONSTRAINT IF EXISTS proof_verifications_chain_id_transaction_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_verifications_constraints
  ON proof_verifications (community_did, chain_id, transaction_hash,
    COALESCE(block_number, -1), COALESCE(contract_address, ''));
