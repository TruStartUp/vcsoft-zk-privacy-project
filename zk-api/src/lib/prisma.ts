import { PrismaClient } from "@prisma/client";

import { config } from "../config/index.js";

export const prisma = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
  log: config.env === "development" ? ["warn", "error"] : config.env === "test" ? [] : ["error"],
});

export type PrismaTransaction = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
