import { execFileSync } from "node:child_process";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  process.stderr.write("TEST_DATABASE_URL is not set; see .env.example\n");
  process.exit(1);
}

execFileSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
