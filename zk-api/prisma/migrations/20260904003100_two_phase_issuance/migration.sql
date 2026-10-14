-- Two-time issuance. The issuer no longer derives the holder's secret, so the
-- leaf cannot be built at approval time: `commitment`, `secretHash` and
-- `leafIndex` arrive at activation and are null until then.

ALTER TABLE "credentials" ALTER COLUMN "commitment" DROP NOT NULL;
ALTER TABLE "credentials" ALTER COLUMN "leafIndex" DROP NOT NULL;
ALTER TABLE "credentials" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "credentials" ALTER COLUMN "inTree" SET DEFAULT false;

ALTER TABLE "credentials" ADD COLUMN "secretHash" TEXT;
ALTER TABLE "credentials" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "credentials" ADD COLUMN "holderAddress" TEXT NOT NULL DEFAULT '';
ALTER TABLE "credentials" ALTER COLUMN "holderAddress" DROP DEFAULT;

-- Uniqueness on the hash costs nothing and catches one wallet standing behind
-- two KYC identifiers. Two wallets for the same person it cannot catch: that is
-- the KYC provider's deduplication and nothing else.
CREATE UNIQUE INDEX "credentials_secretHash_key" ON "credentials"("secretHash");

-- The Sybil control moves from the derivation to the database: at most one
-- credential per subject that is still alive. A revoked one no longer blocks,
-- which is what makes reissuance after a lost wallet possible.
DROP INDEX "credentials_subjectRef_key";
CREATE INDEX "credentials_subjectRef_idx" ON "credentials"("subjectRef");
CREATE INDEX "credentials_holderAddress_idx" ON "credentials"("holderAddress");
CREATE UNIQUE INDEX "credentials_subjectRef_live_key"
  ON "credentials"("subjectRef")
  WHERE "status" IN ('PENDING', 'ACTIVE', 'SUSPENDED');
