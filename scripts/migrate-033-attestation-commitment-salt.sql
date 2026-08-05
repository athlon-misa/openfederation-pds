-- Salt new private-attestation commitments to prevent offline dictionary attacks.
ALTER TABLE attestation_encryption ADD COLUMN IF NOT EXISTS commitment_salt VARCHAR(128);
