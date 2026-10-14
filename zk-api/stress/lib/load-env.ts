import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "dotenv";

/// Imported first by every stress script. The file DOTENV_CONFIG_PATH names wins over
/// anything already in the environment, because Prisma loads `.env` on its own the
/// first time a client is built and would otherwise point the run at the development
/// database.
const file = process.env.DOTENV_CONFIG_PATH;
if (file) {
  const path = resolve(import.meta.dirname, "../..", file);
  if (existsSync(path)) Object.assign(process.env, parse(readFileSync(path)));
}
