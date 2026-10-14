import pino from "pino";

import { config } from "../config/index.js";

/// Nothing that identifies a holder is allowed into the log stream: the point of
/// the layer is that this data does not leave the sealed envelope.
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.x-partner-signature",
      "req.headers.authorization",
      "*.secret",
      "*.kycSubjectId",
      "*.identity",
      "*.privateKey",
    ],
    censor: "[redacted]",
  },
  base: { service: "zk-api" },
});
