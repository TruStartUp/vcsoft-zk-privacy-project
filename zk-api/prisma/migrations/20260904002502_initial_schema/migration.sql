-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TreeKind" AS ENUM ('CREDENTIAL', 'JURISDICTION');

-- CreateEnum
CREATE TYPE "DisclosureStatus" AS ENUM ('PENDING', 'APPROVED', 'RELEASED', 'DENIED');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "partnerKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" TEXT[],
    "sealedSecret" BYTEA NOT NULL,
    "secretNonce" BYTEA NOT NULL,
    "secretTag" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "commitment" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "leafIndex" INTEGER NOT NULL,
    "countryCode" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "inTree" BOOLEAN NOT NULL DEFAULT true,
    "verificationRef" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspendedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_envelopes" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "viewingKeyId" TEXT NOT NULL,
    "ephemeralPublicKey" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "aad" BYTEA NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resealedAt" TIMESTAMP(3),

    CONSTRAINT "identity_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jurisdiction_leaves" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "leafIndex" INTEGER NOT NULL,
    "countryCode" INTEGER NOT NULL,
    "admitted" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jurisdiction_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "root_publications" (
    "id" TEXT NOT NULL,
    "kind" "TreeKind" NOT NULL,
    "assetId" TEXT,
    "root" TEXT NOT NULL,
    "previousRoot" TEXT,
    "leafCount" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "root_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosure_requests" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "requesterRef" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "legalBasis" TEXT NOT NULL,
    "scope" TEXT[],
    "targetCommitment" TEXT NOT NULL,
    "status" "DisclosureStatus" NOT NULL DEFAULT 'PENDING',
    "requestSignature" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "disclosure_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proof_verifications" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT,
    "assetId" TEXT NOT NULL,
    "nullifier" TEXT NOT NULL,
    "epochEnd" BIGINT NOT NULL,
    "credentialRoot" TEXT NOT NULL,
    "countryRoot" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "proofDigest" TEXT NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "rejectionCode" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proof_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_log_entries" (
    "id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "partnerId" TEXT,
    "partnerKey" TEXT NOT NULL,
    "actorRef" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "scope" TEXT,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "outcome" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursors" (
    "name" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_cursors_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_partnerKey_key" ON "partners"("partnerKey");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_commitment_key" ON "credentials"("commitment");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_subjectRef_key" ON "credentials"("subjectRef");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_leafIndex_key" ON "credentials"("leafIndex");

-- CreateIndex
CREATE INDEX "credentials_status_idx" ON "credentials"("status");

-- CreateIndex
CREATE UNIQUE INDEX "identity_envelopes_credentialId_key" ON "identity_envelopes"("credentialId");

-- CreateIndex
CREATE INDEX "identity_envelopes_viewingKeyId_idx" ON "identity_envelopes"("viewingKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "jurisdiction_leaves_assetId_leafIndex_key" ON "jurisdiction_leaves"("assetId", "leafIndex");

-- CreateIndex
CREATE UNIQUE INDEX "jurisdiction_leaves_assetId_countryCode_key" ON "jurisdiction_leaves"("assetId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "root_publications_txHash_key" ON "root_publications"("txHash");

-- CreateIndex
CREATE INDEX "root_publications_kind_assetId_idx" ON "root_publications"("kind", "assetId");

-- CreateIndex
CREATE INDEX "disclosure_requests_targetCommitment_idx" ON "disclosure_requests"("targetCommitment");

-- CreateIndex
CREATE INDEX "disclosure_requests_status_idx" ON "disclosure_requests"("status");

-- CreateIndex
CREATE INDEX "proof_verifications_nullifier_idx" ON "proof_verifications"("nullifier");

-- CreateIndex
CREATE INDEX "proof_verifications_assetId_idx" ON "proof_verifications"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "access_log_entries_sequence_key" ON "access_log_entries"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "access_log_entries_entryHash_key" ON "access_log_entries"("entryHash");

-- CreateIndex
CREATE INDEX "access_log_entries_partnerKey_idx" ON "access_log_entries"("partnerKey");

-- CreateIndex
CREATE INDEX "access_log_entries_resourceType_resourceId_idx" ON "access_log_entries"("resourceType", "resourceId");

-- AddForeignKey
ALTER TABLE "identity_envelopes" ADD CONSTRAINT "identity_envelopes_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosure_requests" ADD CONSTRAINT "disclosure_requests_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_log_entries" ADD CONSTRAINT "access_log_entries_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
