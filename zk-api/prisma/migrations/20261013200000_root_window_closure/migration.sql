-- AlterTable
ALTER TABLE "root_publications" ADD COLUMN     "commitment" TEXT,
ADD COLUMN     "invalidationRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invalidatedAt" TIMESTAMP(3),
ADD COLUMN     "invalidationTxHash" TEXT;

-- CreateIndex
CREATE INDEX "root_publications_commitment_idx" ON "root_publications"("commitment");
