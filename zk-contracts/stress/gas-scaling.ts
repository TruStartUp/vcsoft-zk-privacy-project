import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AbiCoder, Wallet } from "ethers";
import { ethers, network } from "hardhat";

import { CREDENTIAL_TREE_DEPTH, JURISDICTION_TREE_DEPTH } from "../../zk-api/src/lib/field";
import { SparseMerkleTree } from "../../zk-api/src/lib/merkle";
import { poseidonHash, type HashFn } from "../../zk-api/src/lib/poseidon";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const snarkjs = require("snarkjs");

const BUILD = resolve(__dirname, "../../zk-circuits/build");
const WASM = `${BUILD}/compliance_js/compliance.wasm`;
const ZKEY = `${BUILD}/groth16.zkey`;
const EPOCH_LENGTH = 2_592_000;
const ASSET_ID = 42n;
const COUNTRY = 170n;
const EXPIRY = 4_000_000_000n;
const TREE_SIZES = [1, 100, 1_000, 10_000];
const UPDATE_SIZES = [1, 10, 50, 100, 250, 500, 1_000, 2_000];
const COUNTRY_UPDATE_SIZES = [1, 10, 100, 256];
const CAPACITY = 2 ** CREDENTIAL_TREE_DEPTH;
const coder = AbiCoder.defaultAbiCoder();

const log = (text = "") => console.log(text.length ? `[${new Date().toISOString()}] ${text}` : "");
const heading = (text: string) => {
  log();
  log(`=== ${text}`);
};

function fit(points: [number, number][]) {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const slope = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  const ssTot = points.reduce((s, [, y]) => s + (y - my) ** 2, 0);
  const ssRes = points.reduce((s, [x, y]) => s + (y - (intercept + slope * x)) ** 2, 0);
  return { slope, intercept, r2: 1 - ssRes / ssTot };
}

async function main() {
  if (network.name !== "hardhat") throw new Error("run in-process: npx hardhat run stress/gas-scaling.ts");
  const [admin, issuer, jurisdiction, platform] = await ethers.getSigners();
  const hash: HashFn = await poseidonHash();

  const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, 900);
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const adapter = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(await verifier.getAddress());
  const attestor = await (await ethers.getContractFactory("ComplianceAttestor")).deploy(
    admin.address,
    await registry.getAddress(),
    await adapter.getAddress(),
    EPOCH_LENGTH,
  );
  await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address);
  await registry.grantRole(await registry.JURISDICTION_ROLE(), jurisdiction.address);
  await attestor.grantRole(await attestor.ATTESTATION_MANAGER_ROLE(), admin.address);
  const block = await ethers.provider.getBlock("latest");
  log(`Hardhat Network en proceso · chainId ${network.config.chainId} · límite de gas por bloque ${block!.gasLimit}`);

  const countryTree = SparseMerkleTree.from(JURISDICTION_TREE_DEPTH, hash, [[0, COUNTRY]]);
  await registry.connect(jurisdiction).publishCountryRoot(ASSET_ID, countryTree.root(), [{ leafIndex: 0, countryCode: Number(COUNTRY), admitted: true }]);

  heading("publishCredentialRoot frente al número de cambios de hoja");
  let salt = 1n;
  const freshRoot = () => hash(salt++, 7n);
  await (await registry.connect(issuer).publishCredentialRoot(freshRoot(), [])).wait();
  const publication: [number, number][] = [];
  for (const size of UPDATE_SIZES) {
    const updates = Array.from({ length: size }, (_, i) => ({ leafIndex: i, commitment: hash(salt, BigInt(i)), inserted: true }));
    const receipt = await (await registry.connect(issuer).publishCredentialRoot(freshRoot(), updates)).wait();
    publication.push([size, Number(receipt!.gasUsed)]);
    log(`${String(size).padStart(5)} cambios: ${receipt!.gasUsed} gas · ${(Number(receipt!.gasUsed) / size).toFixed(0)} por cambio`);
  }
  const line = fit(publication);
  log(`ajuste: ${line.intercept.toFixed(0)} gas + ${line.slope.toFixed(1)} gas por cambio (R² ${line.r2.toFixed(6)})`);
  log(`cambios que caben en un bloque de ${block!.gasLimit} gas: ${Math.floor((Number(block!.gasLimit) - line.intercept) / line.slope)}`);
  const previous = await registry.credentialRoot();
  await (await registry.connect(issuer).publishCredentialRoot(freshRoot(), [{ leafIndex: 0, commitment: 1n, inserted: true }])).wait();
  const invalidation = await (await registry.connect(issuer).invalidateCredentialRoot(previous)).wait();
  log(`invalidateCredentialRoot: ${invalidation!.gasUsed} gas`);
  const summary: Record<string, number> = {
    publishCredentialRoot1: publication[0]![1],
    invalidateCredentialRoot: Number(invalidation!.gasUsed),
  };

  heading("publishCountryRoot frente al número de cambios");
  for (const size of COUNTRY_UPDATE_SIZES) {
    const tree = SparseMerkleTree.from(
      JURISDICTION_TREE_DEPTH,
      hash,
      Array.from({ length: size }, (_, i) => [i, BigInt(i + 1)] as [number, bigint]),
    );
    const updates = Array.from({ length: size }, (_, i) => ({ leafIndex: i, countryCode: i + 1, admitted: true }));
    const receipt = await (await registry.connect(jurisdiction).publishCountryRoot(1000n + BigInt(size), tree.root(), updates)).wait();
    log(`${String(size).padStart(4)} países: ${receipt!.gasUsed} gas`);
  }

  heading("attestFor frente al tamaño del árbol de credenciales (prueba Groth16 real en cada caso)");
  const attestGas: number[] = [];
  const cases = [...TREE_SIZES.map((size) => ({ size, index: size - 1, label: `${size} hojas, titular en la última` })), {
    size: 3,
    index: CAPACITY - 1,
    label: `titular en el índice 2^20 − 1 (${CAPACITY - 1})`,
  }];
  for (const [k, scenario] of cases.entries()) {
    const secret = 0x5eec12eb0ff1ce5eec12eb0ff1cen + BigInt(k);
    const commitment = hash(hash(secret), COUNTRY, EXPIRY);
    const t0 = Date.now();
    const leaves: [number, bigint][] = [];
    for (let i = 0; i < scenario.size - 1; i += 1) leaves.push([i, hash(BigInt(i) + 11n, COUNTRY, EXPIRY)]);
    leaves.push([scenario.index, commitment]);
    const tree = SparseMerkleTree.from(CREDENTIAL_TREE_DEPTH, hash, leaves);
    const buildMs = Date.now() - t0;
    await (await registry.connect(issuer).publishCredentialRoot(tree.root(), [{ leafIndex: scenario.index, commitment, inserted: true }])).wait();

    const subject = Wallet.createRandom().address;
    const epochEnd = await attestor.currentEpochEnd();
    const anchor = await attestor.anchorFor(subject);
    const credential = tree.opening(scenario.index);
    const country = countryTree.opening(0);
    const input = {
      credentialRoot: String(tree.root()),
      countryRoot: String(countryTree.root()),
      assetId: String(ASSET_ID),
      epochEnd: String(epochEnd),
      nullifier: String(hash(secret, ASSET_ID, epochEnd)),
      anchor: String(anchor),
      secret: String(secret),
      country: String(COUNTRY),
      expiry: String(EXPIRY),
      credentialPathElements: credential.pathElements,
      credentialPathIndices: credential.pathIndices,
      countryPathElements: country.pathElements,
      countryPathIndices: country.pathIndices,
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const [a, b, c, signals] = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
    const body = coder.encode(["uint256[2]", "uint256[2][2]", "uint256[2]"], [a, b, c]);
    const receipt = await (await attestor.connect(platform).attestFor(subject, body, signals)).wait();
    attestGas.push(Number(receipt!.gasUsed));
    const zeroBytes = (body.slice(2).match(/.{2}/g) ?? []).filter((byte) => byte === "00").length;
    log(`${scenario.label}: attestFor ${receipt!.gasUsed} gas · árbol en ${buildMs} ms · bytes nulos en la prueba ${zeroBytes} · atestado ${await attestor.isAttested(ASSET_ID, subject)}`);
    if (k === 0) {
      const revoke = await (await attestor.connect(admin).revokeAttestation(ASSET_ID, subject)).wait();
      log(`revokeAttestation: ${revoke!.gasUsed} gas`);
      summary.revokeAttestation = Number(revoke!.gasUsed);
    }
  }
  const mean = attestGas.reduce((s, g) => s + g, 0) / attestGas.length;
  const spread = Math.max(...attestGas.map((g) => Math.abs(g - mean) / mean));
  log(`attestFor: media ${mean.toFixed(0)} gas · desviación máxima respecto de la media ${(spread * 100).toFixed(3)} % · mínimo ${Math.min(...attestGas)} · máximo ${Math.max(...attestGas)}`);
  summary.attestFor = Math.round(mean);
  mkdirSync(join(__dirname, "out"), { recursive: true });
  writeFileSync(join(__dirname, "out", "gas.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
