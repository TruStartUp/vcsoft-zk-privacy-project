import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

const ROOT_VALIDITY_WINDOW = 900;
const EPOCH_LENGTH = 2_592_000;
const OUTPUT = join(__dirname, "out", `${network.name}.json`);

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 31337n) throw new Error(`refusing to deploy the stress stack on chainId ${chainId}`);

  const [admin, issuer] = await ethers.getSigners();
  const deploymentBlock = await ethers.provider.getBlockNumber();

  const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, ROOT_VALIDITY_WINDOW);
  const groth16 = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const adapter = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(await groth16.getAddress());
  const attestor = await (await ethers.getContractFactory("ComplianceAttestor")).deploy(
    admin.address,
    await registry.getAddress(),
    await adapter.getAddress(),
    EPOCH_LENGTH,
  );

  await (await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address)).wait();
  await (await registry.grantRole(await registry.JURISDICTION_ROLE(), issuer.address)).wait();
  await (await attestor.grantRole(await attestor.ATTESTATION_MANAGER_ROLE(), admin.address)).wait();

  const record = {
    network: network.name,
    chainId: Number(chainId),
    deploymentBlock,
    rootValidityWindow: ROOT_VALIDITY_WINDOW,
    epochLength: EPOCH_LENGTH,
    admin: admin.address,
    issuer: issuer.address,
    credentialRegistry: await registry.getAddress(),
    groth16Verifier: await groth16.getAddress(),
    groth16VerifierAdapter: await adapter.getAddress(),
    complianceAttestor: await attestor.getAddress(),
    scheme: await adapter.scheme(),
  };
  mkdirSync(join(__dirname, "out"), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
