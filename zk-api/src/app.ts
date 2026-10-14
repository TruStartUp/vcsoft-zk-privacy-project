import express, { type Express, type Request } from "express";
import pinoHttp from "pino-http";

import { logger } from "./lib/logger.js";
import { logUnauthenticated } from "./middleware/access-log.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import { requirePartner } from "./middleware/partner-auth.js";
import { auditRouter } from "./routes/audit.routes.js";
import { credentialsRouter } from "./routes/credentials.routes.js";
import { docsRouter } from "./routes/docs.routes.js";
import { disclosuresRouter } from "./routes/disclosures.routes.js";
import { issuerRouter } from "./routes/issuer.routes.js";
import { verificationRouter } from "./routes/verification.routes.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(pinoHttp({ logger }));

  // The signature covers the bytes that arrived, not the object they parsed
  // into, so the raw body is kept for the verifier.
  app.use(
    express.json({
      limit: "256kb",
      verify: (req: Request, _res, buffer: Buffer) => {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "zk-api" });
  });

  app.use(docsRouter);

  const v1 = express.Router();
  v1.use(logUnauthenticated);
  v1.use(requirePartner);
  v1.use(credentialsRouter);
  v1.use(verificationRouter);
  v1.use(disclosuresRouter);
  v1.use(auditRouter);
  v1.use(issuerRouter);
  app.use("/v1", v1);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
