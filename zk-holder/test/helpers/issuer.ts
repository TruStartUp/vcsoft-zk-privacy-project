import { randomBytes } from "node:crypto";

/// The issuer's own code, loaded with a throwaway configuration, so the client is
/// checked against what the service would actually compute rather than against a copy.
export const deployment = {
  chainId: 84532,
  credentialRegistry: "0xA3fcAb3e8da5546BeBE66A88E581621a8b27B8AA" as const,
};

const key = () => randomBytes(32).toString("base64");

function configureIssuerEnvironment(): void {
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: "/nonexistent/.env",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_PORT: "3999",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    REDIS_URL: "redis://127.0.0.1:1",
    CHAIN_RPC_URL: "http://127.0.0.1:1",
    CHAIN_ID: String(deployment.chainId),
    CREDENTIAL_REGISTRY_ADDRESS: deployment.credentialRegistry,
    COMPLIANCE_ATTESTOR_ADDRESS: "0x83C0429F5b15CBC5d4eE0Fc7e74b23A23daB9D09",
    REGISTRY_DEPLOYMENT_BLOCK: "0",
    ISSUER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    PROOF_SCHEME: "groth16",
    PROOF_VERIFICATION_KEY_PATH: "unused",
    SUBJECT_REFERENCE_KEY: key(),
    DISCLOSURE_VIEWING_KEYS: `vk-test:${key()}`,
    DISCLOSURE_ACTIVE_VIEWING_KEY: "vk-test",
    PARTNER_SECRET_ENCRYPTION_KEY: key(),
    PARTNER_SIGNATURE_WINDOW_SECONDS: "300",
    ACCESS_LOG_HMAC_KEY: key(),
  });
}

export async function issuerModules() {
  configureIssuerEnvironment();
  const [material, holderSecret, merkle, poseidon, signing] = await Promise.all([
    import("../../../zk-api/src/services/credential-material.service.js"),
    import("../../../zk-api/src/lib/holder-secret.js"),
    import("../../../zk-api/src/lib/merkle.js"),
    import("../../../zk-api/src/lib/poseidon.js"),
    import("../../../zk-api/src/lib/signing.js"),
  ]);
  return { material, holderSecret, merkle, poseidon, signing };
}
