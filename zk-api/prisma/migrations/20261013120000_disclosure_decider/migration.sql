-- AlterTable
ALTER TABLE "disclosure_requests" ADD COLUMN     "decidedByActor" TEXT,
ADD COLUMN     "decidedByPartnerId" TEXT;

-- AddForeignKey
ALTER TABLE "disclosure_requests" ADD CONSTRAINT "disclosure_requests_decidedByPartnerId_fkey" FOREIGN KEY ("decidedByPartnerId") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The partner that decides a disclosure request is never the one that made it.
ALTER TABLE "disclosure_requests" ADD CONSTRAINT "disclosure_requests_decider_is_not_requester"
  CHECK ("decidedByPartnerId" IS NULL OR "decidedByPartnerId" <> "partnerId");
