import { Router } from "express";

import { logAccess } from "../middleware/access-log.js";
import { requireScope } from "../middleware/partner-auth.js";
import { validate } from "../middleware/validate.js";
import { queryAccessLog, verifyAccessLogIntegrity } from "../services/access-log.service.js";
import { accessLogQuerySchema } from "./schemas.js";

export const auditRouter: Router = Router();

/// The audit trail of the layer: who reached which resource, when, under which
/// scope, and whether they were granted it.
auditRouter.get(
  "/access-log",
  logAccess("access_log"),
  requireScope("audit:read"),
  validate(accessLogQuerySchema, "query"),
  async (req, res) => {
    const query = req.query as unknown as {
      partnerKey?: string;
      resourceType?: string;
      resourceId?: string;
      from?: Date;
      to?: Date;
      limit: number;
      cursor?: string;
    };
    res.json(await queryAccessLog(query));
  },
);

/// Lets an auditor check the chain themselves rather than trusting that it was
/// checked. It names the first entry that does not verify.
auditRouter.get("/access-log/integrity", logAccess("access_log"), requireScope("audit:read"), async (_req, res) => {
  const verification = await verifyAccessLogIntegrity();
  res.json({
    intact: verification.intact,
    entries: verification.entries,
    checked: verification.checked,
    brokenAtSequence: verification.brokenAtSequence?.toString() ?? null,
    reason: verification.reason ?? null,
  });
});
