import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env" });

if (!process.env.DATABASE_URL) {
  process.stderr.write("DATABASE_URL is not set; see .env.example\n");
  process.exit(1);
}

execFileSync("npx", ["prisma", "migrate", "deploy"], { stdio: "inherit", env: process.env });
