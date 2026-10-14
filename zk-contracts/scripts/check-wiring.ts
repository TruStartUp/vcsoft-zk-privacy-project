import "./lib/redact";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { contracts as trex } from "@erc3643org/erc-3643";
import { requireDeployment, sleep } from "./lib/deployment";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

let passed = 0;
let failed = 0;

const show = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(show).join(", ")}]` : String(value);

async function check(label: string, read: () => Promise<unknown>, expected: unknown): Promise<void> {
  const want = show(expected).toLowerCase();
  let got = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      got = show(await read());
    } catch (error) {
      got = `error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
    if (got.toLowerCase() === want) break;
    await sleep(2000);
  }
  const ok = got.toLowerCase() === want;
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got}${ok ? "" : `  (expected ${show(expected)})`}`);
}

async function main() {
  const deployment = requireDeployment();
  const { contracts: c, parameters: p, external: e } = deployment;
  const X = p.deployer as string;
  const Y = p.platform as string;
  const assetId = BigInt(p.assetId as string);

  console.log(`Network: ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  console.log(`Block:   ${await ethers.provider.getBlockNumber()}`);
  console.log(`X (deployer) ${X}`);
  console.log(`Y (platform) ${Y}\n`);

  const adapter = await ethers.getContractAt("Groth16VerifierAdapter", c.groth16VerifierAdapter.address);
  const registry = await ethers.getContractAt("CredentialRegistry", c.credentialRegistry.address);
  const attestor = await ethers.getContractAt("ComplianceAttestor", c.complianceAttestor.address);
  const module = await ethers.getContractAt("ZKComplianceModule", c.zkComplianceModule.address);

  console.log("Verifier and attestor");
  await check("adapter.verifier()", () => adapter.verifier(), c.groth16Verifier.address);
  await check("adapter.scheme()", () => adapter.scheme(), "groth16");
  await check("attestor.verifier()", () => attestor.verifier(), c.groth16VerifierAdapter.address);
  await check("attestor.registry()", () => attestor.registry(), c.credentialRegistry.address);
  await check("attestor.epochLength()", () => attestor.epochLength(), p.epochLength);
  await check("registry.rootValidityWindow()", () => registry.rootValidityWindow(), p.rootValidityWindow);

  console.log("\nRoles");
  const admin = await registry.DEFAULT_ADMIN_ROLE();
  const roles: [string, Contract, string, string, boolean][] = [
    ["registry DEFAULT_ADMIN_ROLE", registry as unknown as Contract, admin, X, true],
    ["registry DEFAULT_ADMIN_ROLE", registry as unknown as Contract, admin, Y, false],
    ["registry ISSUER_ROLE", registry as unknown as Contract, await registry.ISSUER_ROLE(), Y, true],
    ["registry ISSUER_ROLE", registry as unknown as Contract, await registry.ISSUER_ROLE(), X, false],
    ["registry JURISDICTION_ROLE", registry as unknown as Contract, await registry.JURISDICTION_ROLE(), Y, true],
    ["registry JURISDICTION_ROLE", registry as unknown as Contract, await registry.JURISDICTION_ROLE(), X, false],
    ["attestor DEFAULT_ADMIN_ROLE", attestor as unknown as Contract, admin, X, true],
    ["attestor DEFAULT_ADMIN_ROLE", attestor as unknown as Contract, admin, Y, false],
    ["attestor ATTESTATION_MANAGER_ROLE", attestor as unknown as Contract, await attestor.ATTESTATION_MANAGER_ROLE(), Y, true],
    ["attestor ATTESTATION_MANAGER_ROLE", attestor as unknown as Contract, await attestor.ATTESTATION_MANAGER_ROLE(), X, false],
  ];
  for (const [label, contract, role, account, expected] of roles) {
    await check(`${label} held by ${account === X ? "X" : "Y"}`, () => contract.hasRole(role, account), expected);
  }

  console.log("\nModule proxy");
  await check(
    "proxy implementation (ERC-1967 slot)",
    async () => ethers.getAddress(ethers.dataSlice(await ethers.provider.getStorage(c.zkComplianceModule.address, IMPLEMENTATION_SLOT), 12)),
    c.zkComplianceModuleImplementation.address,
  );
  await check("module.attestor()", () => module.attestor(), c.complianceAttestor.address);
  await check("module.owner()", () => module.owner(), X);

  if (c.token === undefined) {
    console.log("\nT-REX suite: not deployed yet, suite checks skipped");
  } else {
    const token = new Contract(c.token.address, trex.Token.abi, ethers.provider);
    const mc = new Contract(c.modularCompliance.address, trex.ModularCompliance.abi, ethers.provider);
    const ir = new Contract(c.identityRegistry.address, trex.IdentityRegistry.abi, ethers.provider);
    const tir = new Contract(c.trustedIssuersRegistry.address, trex.TrustedIssuersRegistry.abi, ethers.provider);
    const ctr = new Contract(c.claimTopicsRegistry.address, trex.ClaimTopicsRegistry.abi, ethers.provider);
    const factory = new Contract(e.trexFactory, trex.TREXFactory.abi, ethers.provider);

    console.log("\nT-REX suite");
    await check(`factory.getToken("${p.salt}")`, () => factory.getToken(p.salt), c.token.address);
    await check("token.name()", () => token.name(), p.tokenName);
    await check("token.symbol()", () => token.symbol(), p.tokenSymbol);
    await check("token.decimals()", () => token.decimals(), p.tokenDecimals);
    await check("token.compliance()", () => token.compliance(), c.modularCompliance.address);
    await check("token.identityRegistry()", () => token.identityRegistry(), c.identityRegistry.address);
    await check("token.paused()", () => token.paused(), false);
    await check("mc.getTokenBound()", () => mc.getTokenBound(), c.token.address);
    await check("mc.getModules()", () => mc.getModules(), [c.zkComplianceModule.address]);
    await check("mc.isModuleBound(module)", () => mc.isModuleBound(c.zkComplianceModule.address), true);
    await check("module.isComplianceBound(mc)", () => module.isComplianceBound(c.modularCompliance.address), true);
    await check("module.assetIdOf(mc)", () => module.assetIdOf(c.modularCompliance.address), assetId);
    await check("module.complianceOfAsset(assetId)", () => module.complianceOfAsset(assetId), c.modularCompliance.address);
    await check("ctr.getClaimTopics()", () => ctr.getClaimTopics(), p.claimTopics as number[]);
    await check("tir.getTrustedIssuers()", () => tir.getTrustedIssuers(), [e.claimIssuer]);
    await check("tir.getTrustedIssuerClaimTopics(claimIssuer)", () => tir.getTrustedIssuerClaimTopics(e.claimIssuer), p.claimTopics as number[]);

    console.log("\nOwners and agents");
    await check("token.owner()", () => token.owner(), X);
    await check("mc.owner()", () => mc.owner(), X);
    await check("ir.owner()", () => ir.owner(), X);
    await check("token.isAgent(Y)", () => token.isAgent(Y), true);
    await check("ir.isAgent(Y)", () => ir.isAgent(Y), true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
