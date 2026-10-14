import "./lib/redact";
import { ethers, network } from "hardhat";
import { Contract, ContractFactory, NonceManager, Wallet, type InterfaceAbi } from "ethers";
import { contracts as trex } from "@erc3643org/erc-3643";
import {
  TransactionLedger,
  deploymentPath,
  displayPath,
  loadDeployment,
  pollUntil,
  saveDeployment,
  type Deployment,
} from "./lib/deployment";

const CHAIN_ID = 84532n;

const TREX_FACTORY = "0x599e0AC637FD3B598b13bbB1729EC4ed967875fF";
const CLAIM_ISSUER = "0xD60B8E767c0f830b95Fc0cD87B71643c47aF9492";
const KYC_CLAIM_TOPIC = 1;

const SALT = "ZKCONF-20261013";
const ASSET_ID = 84532001n;
const TOKEN_NAME = "ZK Confidential Test Asset";
const TOKEN_SYMBOL = "ZKCTA";
const TOKEN_DECIMALS = 18;
const ROOT_VALIDITY_WINDOW = 900;
const EPOCH_LENGTH = 2_592_000;

const MIN_BALANCE = ethers.parseEther("0.03");

type Signer = NonceManager & { address: string };

function signerFrom(variable: string): Signer | undefined {
  const key = process.env[variable]?.trim();
  if (!key) return undefined;
  const wallet = new Wallet(key, ethers.provider);
  return Object.assign(new NonceManager(wallet), { address: wallet.address });
}

function published(artifact: { abi: unknown; bytecode: string }): ContractFactory {
  return new ContractFactory(artifact.abi as InterfaceAbi, artifact.bytecode);
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== CHAIN_ID) throw new Error(`refusing to deploy on chainId ${chainId}: only Base Sepolia (${CHAIN_ID})`);

  const deployer = signerFrom("DEPLOYER_PRIVATE_KEY");
  if (deployer === undefined) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const platformSigner = signerFrom("PLATFORM_PRIVATE_KEY");

  const factory = new Contract(TREX_FACTORY, trex.TREXFactory.abi, ethers.provider);
  const platform: string = await factory.owner();
  const authority = new Contract(
    await factory.getImplementationAuthority(),
    trex.TREXImplementationAuthority.abi,
    ethers.provider,
  );
  const infrastructureOwner: string = await authority.owner();

  if (deployer.address !== infrastructureOwner) {
    throw new Error(`deployer ${deployer.address} is not the owner of the T-REX infrastructure (${infrastructureOwner})`);
  }
  if (platformSigner !== undefined && platformSigner.address !== platform) {
    throw new Error(`PLATFORM_PRIVATE_KEY signs as ${platformSigner.address}, the T-REX factory owner is ${platform}`);
  }

  const startBalances = new Map<string, bigint>();
  for (const [label, address] of [["X", deployer.address], ["Y", platform]] as const) {
    const balance = await ethers.provider.getBalance(address);
    startBalances.set(address, balance);
    console.log(`${label} ${address} balance ${ethers.formatEther(balance)} ETH`);
    if (balance < MIN_BALANCE) throw new Error(`${label} holds less than ${ethers.formatEther(MIN_BALANCE)} ETH`);
  }

  const parameters = {
    salt: SALT,
    assetId: ASSET_ID.toString(),
    tokenName: TOKEN_NAME,
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: TOKEN_DECIMALS,
    rootValidityWindow: ROOT_VALIDITY_WINDOW,
    epochLength: EPOCH_LENGTH,
    claimTopics: [KYC_CLAIM_TOPIC],
    deployer: deployer.address,
    platform,
  };
  const deployment: Deployment = loadDeployment() ?? {
    network: network.name,
    chainId: Number(CHAIN_ID),
    parameters,
    external: { trexFactory: TREX_FACTORY, trexImplementationAuthority: await authority.getAddress(), claimIssuer: CLAIM_ISSUER },
    contracts: {},
    transactions: {},
  };
  if (JSON.stringify(deployment.parameters) !== JSON.stringify(parameters)) {
    throw new Error(`${displayPath(deploymentPath())} was written with other parameters; refusing to mix deployments`);
  }
  saveDeployment(deployment);
  const ledger = new TransactionLedger(deployment);

  async function deploy(key: string, signerLabel: string, signer: Signer, factory: ContractFactory, args: unknown[] = []) {
    const known = deployment.contracts[key];
    if (known !== undefined) {
      console.log(`  skip ${key} ${known.address}`);
      return known.address;
    }
    const txKey = `deploy:${key}`;
    await ledger.run(txKey, signerLabel, async () => signer.sendTransaction(await factory.getDeployTransaction(...args)));
    const record = ledger.record(txKey)!;
    const address = record.contractAddress!;
    await pollUntil(`${key} code`, () => ethers.provider.getCode(address), (code) => code !== "0x");
    deployment.contracts[key] = { address, txHash: record.hash, block: record.block! };
    saveDeployment(deployment);
    console.log(`  ${key} ${address}`);
    return address;
  }

  async function grant(key: string, contract: Contract, roleName: string, account: string) {
    const role: string = await contract[roleName]();
    if (!ledger.isDone(key) && (await contract.hasRole(role, account))) {
      console.log(`  ${key}: ${roleName} already held by ${account}`);
    } else {
      await ledger.run(key, "X", () => (contract.connect(deployer!) as Contract).grantRole(role, account));
    }
    await pollUntil(key, () => contract.hasRole(role, account), (held) => held === true);
  }

  console.log("\n1. Confidentiality layer (signed by X)");
  const verifier = await deploy("groth16Verifier", "X", deployer, await ethers.getContractFactory("Groth16Verifier"));
  const adapter = await deploy("groth16VerifierAdapter", "X", deployer, await ethers.getContractFactory("Groth16VerifierAdapter"), [verifier]);
  const registry = await deploy("credentialRegistry", "X", deployer, await ethers.getContractFactory("CredentialRegistry"), [
    deployer.address,
    ROOT_VALIDITY_WINDOW,
  ]);
  const attestor = await deploy("complianceAttestor", "X", deployer, await ethers.getContractFactory("ComplianceAttestor"), [
    deployer.address,
    registry,
    adapter,
    EPOCH_LENGTH,
  ]);
  const moduleFactory = await ethers.getContractFactory("ZKComplianceModule");
  const implementation = await deploy("zkComplianceModuleImplementation", "X", deployer, moduleFactory);
  const moduleProxy = await deploy("zkComplianceModule", "X", deployer, published(trex.ModuleProxy), [
    implementation,
    moduleFactory.interface.encodeFunctionData("initialize", [attestor]),
  ]);
  const module = moduleFactory.attach(moduleProxy).connect(ethers.provider) as Contract;
  await pollUntil("module attestor", () => module.attestor(), (value) => value === attestor);

  console.log("\n2. Roles for the platform (signed by X)");
  const registryContract = (await ethers.getContractAt("CredentialRegistry", registry)) as unknown as Contract;
  const attestorContract = (await ethers.getContractAt("ComplianceAttestor", attestor)) as unknown as Contract;
  await grant("role:registry.ISSUER_ROLE", registryContract, "ISSUER_ROLE", platform);
  await grant("role:registry.JURISDICTION_ROLE", registryContract, "JURISDICTION_ROLE", platform);
  await grant("role:attestor.ATTESTATION_MANAGER_ROLE", attestorContract, "ATTESTATION_MANAGER_ROLE", platform);

  if (platformSigner === undefined) {
    console.log("\nPLATFORM_PRIVATE_KEY is not set: stopping before the T-REX suite, which only the factory owner can deploy.");
    await report(deployment, startBalances);
    return;
  }

  console.log("\n3. T-REX suite through the shared factory (signed by Y)");
  if (deployment.contracts.token === undefined) {
    const suiteKey = "trex:deployTREXSuite";
    if (ledger.record(suiteKey) === undefined && (await factory.getToken(SALT)) !== ethers.ZeroAddress) {
      throw new Error(`salt ${SALT} is already used on the factory and this record does not know it`);
    }
    await ledger.run(suiteKey, "Y", () =>
      (factory.connect(platformSigner) as Contract).deployTREXSuite(
        SALT,
        {
          owner: deployer.address,
          name: TOKEN_NAME,
          symbol: TOKEN_SYMBOL,
          decimals: TOKEN_DECIMALS,
          irs: ethers.ZeroAddress,
          ONCHAINID: ethers.ZeroAddress,
          irAgents: [platform],
          tokenAgents: [platform],
          complianceModules: [moduleProxy],
          complianceSettings: [moduleFactory.interface.encodeFunctionData("setAssetId", [ASSET_ID])],
        },
        { claimTopics: [KYC_CLAIM_TOPIC], issuers: [CLAIM_ISSUER], issuerClaims: [[KYC_CLAIM_TOPIC]] },
      ),
    );
    const record = ledger.record(suiteKey)!;
    const receipt = await ethers.provider.getTransactionReceipt(record.hash);
    const event = receipt!.logs
      .map((log) => (log.address.toLowerCase() === TREX_FACTORY.toLowerCase() ? factory.interface.parseLog(log) : null))
      .find((parsed) => parsed?.name === "TREXSuiteDeployed");
    if (!event) throw new Error("TREXSuiteDeployed missing from the receipt");
    const suite = {
      token: event.args._token,
      identityRegistry: event.args._ir,
      identityRegistryStorage: event.args._irs,
      trustedIssuersRegistry: event.args._tir,
      claimTopicsRegistry: event.args._ctr,
      modularCompliance: event.args._mc,
    };
    for (const [key, address] of Object.entries(suite)) {
      deployment.contracts[key] = { address, txHash: record.hash, block: record.block! };
      console.log(`  ${key} ${address}`);
    }
    saveDeployment(deployment);
  } else {
    console.log(`  skip suite, token ${deployment.contracts.token.address}`);
  }
  const tokenAddress = deployment.contracts.token.address;
  await pollUntil("factory.getToken", () => factory.getToken(SALT), (value) => value === tokenAddress);
  await pollUntil(
    "module.assetIdOf",
    () => module.assetIdOf(deployment.contracts.modularCompliance.address),
    (value) => value === ASSET_ID,
  );

  const token = new Contract(tokenAddress, trex.Token.abi, ethers.provider);
  if (!ledger.isDone("token:unpause") && (await token.paused())) {
    await ledger.run("token:unpause", "Y", () => (token.connect(platformSigner) as Contract).unpause());
  }
  await pollUntil("token unpaused", () => token.paused(), (paused) => paused === false);

  await report(deployment, startBalances);
}

async function report(deployment: Deployment, startBalances: Map<string, bigint>) {
  console.log("\nContracts");
  for (const [key, record] of Object.entries(deployment.contracts)) {
    console.log(`  ${key.padEnd(34)} ${record.address}  block ${record.block}`);
  }
  if (deployment.contracts.credentialRegistry) {
    console.log(`\nREGISTRY_DEPLOYMENT_BLOCK=${deployment.contracts.credentialRegistry.block}`);
  }
  console.log(`ASSET_ID=${deployment.parameters.assetId}  salt ${deployment.parameters.salt}`);

  console.log("\nFees recorded per signer (all runs)");
  const totals = new Map<string, bigint>();
  for (const tx of Object.values(deployment.transactions)) {
    if (tx.feeWei) totals.set(tx.signer, (totals.get(tx.signer) ?? 0n) + BigInt(tx.feeWei));
  }
  for (const [signer, total] of totals) console.log(`  ${signer} ${ethers.formatEther(total)} ETH`);

  console.log("\nBalances (this run)");
  for (const [address, before] of startBalances) {
    const after = await pollUntil("balance", () => ethers.provider.getBalance(address), () => true);
    console.log(`  ${address} ${ethers.formatEther(before)} -> ${ethers.formatEther(after)} ETH`);
  }
  console.log(`\nRecord: ${displayPath(deploymentPath())}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
