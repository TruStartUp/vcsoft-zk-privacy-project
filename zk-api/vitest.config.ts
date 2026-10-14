import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

loadDotenv();

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is not set; see .env.example");

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // The suite drives one database and one Redis; running files in parallel
    // would have them truncating each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      // The scheme the suite runs the routes under, and the verifying key the committed
      // proof fixtures were generated from. The PLONK key sits beside it and the suite
      // reaches for it explicitly where it walks the other scheme.
      PROOF_SCHEME: "groth16",
      PROOF_VERIFICATION_KEY_PATH: "test/fixtures/groth16.vkey.json",
    },
  },
});
