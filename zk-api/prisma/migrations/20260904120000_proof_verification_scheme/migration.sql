-- The proving scheme a verdict was reached under. Existing rows predate the verifier
-- boundary and were all decided by Groth16, which is what the default records.
ALTER TABLE "proof_verifications"
  ADD COLUMN "scheme" TEXT NOT NULL DEFAULT 'groth16';
