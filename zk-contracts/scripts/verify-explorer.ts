import "./lib/redact";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { config, ethers, network, run } from "hardhat";
import { Etherscan } from "@nomicfoundation/hardhat-verify/etherscan";
import { requireDeployment, sleep, type Deployment } from "./lib/deployment";

const SOLC_LONG_VERSION = "v0.8.17+commit.8df45f5f";

interface Target {
  key: string;
  contract: string;
  args: unknown[];
}

function ownContracts(deployment: Deployment): Target[] {
  const { contracts: c, parameters: p } = deployment;
  return [
    { key: "groth16Verifier", contract: "contracts/verifiers/Groth16Verifier.sol:Groth16Verifier", args: [] },
    {
      key: "groth16VerifierAdapter",
      contract: "contracts/verifiers/Groth16VerifierAdapter.sol:Groth16VerifierAdapter",
      args: [c.groth16Verifier.address],
    },
    {
      key: "credentialRegistry",
      contract: "contracts/CredentialRegistry.sol:CredentialRegistry",
      args: [p.deployer, p.rootValidityWindow],
    },
    {
      key: "complianceAttestor",
      contract: "contracts/ComplianceAttestor.sol:ComplianceAttestor",
      args: [p.deployer, c.credentialRegistry.address, c.groth16VerifierAdapter.address, p.epochLength],
    },
    { key: "zkComplianceModuleImplementation", contract: "contracts/ZKComplianceModule.sol:ZKComplianceModule", args: [] },
  ];
}

/// The package ships ModuleProxy's bytecode but not its build info. Its metadata hash was
/// produced with the proxy under the package's own path (`contracts/...`), so the standard
/// JSON input is rebuilt with that key; the OpenZeppelin sources resolve from node_modules.
const MODULE_PROXY_SOURCE = "contracts/compliance/modular/modules/ModuleProxy.sol";
const ERC3643_ROOT = dirname(require.resolve("@erc3643org/erc-3643/package.json"));
const NODE_MODULES = dirname(dirname(ERC3643_ROOT));

function fileOf(sourceKey: string): string {
  return sourceKey.startsWith("@") ? join(NODE_MODULES, sourceKey) : join(ERC3643_ROOT, sourceKey);
}

function collectSources(entry: string): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  const pending = [entry];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (sources[key]) continue;
    const content = readFileSync(fileOf(key), "utf8");
    sources[key] = { content };
    for (const [, imported] of content.matchAll(/^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']/gm)) {
      pending.push(imported.startsWith(".") ? posix.normalize(posix.join(posix.dirname(key), imported)) : imported);
    }
  }
  return sources;
}

function moduleProxyInput(): string {
  return JSON.stringify({
    language: "Solidity",
    sources: collectSources(MODULE_PROXY_SOURCE),
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } },
    },
  });
}

async function verifyModuleProxy(deployment: Deployment, etherscan: Etherscan): Promise<void> {
  const proxy = deployment.contracts.zkComplianceModule.address;
  if (await etherscan.isVerified(proxy)) {
    console.log("  already verified");
    return;
  }
  const module = await ethers.getContractFactory("ZKComplianceModule");
  const initData = module.interface.encodeFunctionData("initialize", [deployment.contracts.complianceAttestor.address]);
  const args = ethers.AbiCoder.defaultAbiCoder()
    .encode(["address", "bytes"], [deployment.contracts.zkComplianceModuleImplementation.address, initData])
    .slice(2);

  const submission = await etherscan.verify(proxy, moduleProxyInput(), `${MODULE_PROXY_SOURCE}:ModuleProxy`, SOLC_LONG_VERSION, args);
  console.log(`  submitted, guid ${submission.message}`);
  await sleep(5000);
  const status = await etherscan.getVerificationStatus(submission.message);
  if (status.isSuccess() || status.isAlreadyVerified()) {
    console.log(`  ${status.message}`);
    return;
  }
  throw new Error(status.message);
}

function explorerUrl(): string {
  const chain = config.etherscan.customChains.find((entry) => entry.chainId === network.config.chainId);
  if (chain === undefined) throw new Error(`no explorer configured for chainId ${network.config.chainId}`);
  return chain.urls.browserURL.replace(/\/$/, "");
}

async function main() {
  const deployment = requireDeployment();
  const explorer = explorerUrl();
  const chainConfig = await Etherscan.getCurrentChainConfig(network.name, network.provider, config.etherscan.customChains);
  const etherscan = Etherscan.fromChainConfig(config.etherscan.apiKey, chainConfig);

  console.log(`Network: ${network.name} (chainId ${network.config.chainId})\n`);
  const verified: string[] = [];
  const failed: { key: string; reason: string }[] = [];

  const attempt = async (key: string, action: () => Promise<void>) => {
    console.log(`- ${key} ${deployment.contracts[key].address}`);
    try {
      await action();
      verified.push(key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(reason)) {
        console.log("  already verified");
        verified.push(key);
      } else {
        console.log(`  FAILED ${reason}`);
        failed.push({ key, reason });
      }
    }
  };

  for (const target of ownContracts(deployment)) {
    if (deployment.contracts[target.key] === undefined) continue;
    await attempt(target.key, () =>
      run("verify:verify", {
        address: deployment.contracts[target.key].address,
        constructorArguments: target.args,
        contract: target.contract,
      }),
    );
  }
  if (deployment.contracts.zkComplianceModule !== undefined) {
    await attempt("zkComplianceModule", () => verifyModuleProxy(deployment, etherscan));
  }

  console.log("\nVerified:");
  for (const key of verified) console.log(`  ${key.padEnd(34)} ${explorer}/address/${deployment.contracts[key].address}#code`);
  if (failed.length > 0) {
    console.log("\nNot verified:");
    for (const { key, reason } of failed) console.log(`  ${key}: ${reason.split("\n")[0]}`);
  }
  console.log(`\n${verified.length} verified, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
