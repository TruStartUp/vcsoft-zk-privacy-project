/* Regenerates compliance-proofs.json from the compiled circuit in ../zk-circuits/build.
   Run it directly: node test/fixtures/generate-proofs.mjs
   Imported by the test runner it does nothing, so the committed fixture stays authoritative.

   Every proof is bound to the address that will send it and to the attestor that will
   receive it, so the fixture has to know both: the senders are hardhat's deterministic
   accounts and the attestor is the fourth contract deployComplianceStack deploys from
   account 0. helpers.ts checks that assumption still holds before any test runs.

   Every scenario is proved twice, once under each scheme, over the very same witness.
   That is what lets a test walk an entire attestation under PLONK and compare it with
   the Groth16 one signal by signal: same nullifier, same period, same anchor, a
   different proof body and a different verifier behind the boundary. */

import { fileURLToPath } from "node:url";

const CIRCUIT_BUILD = "../../../zk-circuits/build";
const CREDENTIAL_DEPTH = 20;
const COUNTRY_DEPTH = 8;

const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const HARDHAT_CHAIN_ID = 31337n;
// registry, Groth16Verifier, Groth16VerifierAdapter, ComplianceAttestor.
const ATTESTOR_DEPLOYMENT_NONCE = 3;

const EPOCH_LENGTH = 30 * 24 * 60 * 60;
const NOW_TIMESTAMP = Math.floor(Date.UTC(2040, 0, 1) / 1000);
const CURRENT_EPOCH_END = BigInt((Math.floor(NOW_TIMESTAMP / EPOCH_LENGTH) + 1) * EPOCH_LENGTH);
const NEXT_EPOCH_END = CURRENT_EPOCH_END + BigInt(EPOCH_LENGTH);
const PAST_EPOCH_END = CURRENT_EPOCH_END - BigInt(EPOCH_LENGTH);
const FAR_FUTURE_EPOCH_END = CURRENT_EPOCH_END + 2n * BigInt(EPOCH_LENGTH);
const MISALIGNED_EPOCH_END = CURRENT_EPOCH_END + 1n;

const LONG_EXPIRY = Math.floor(Date.UTC(2050, 0, 1) / 1000);

const ASSET_A = 42n;
const ASSET_B = 43n;

// Carla's credential runs out exactly when this period does: the circuit lets her
// prove this one and refuses the next, which is the guarantee that an attestation
// never outlives the credential behind it.
const ALICE = { secret: 0xa11ce0000000000000000000000000000000000000000000n, country: 724n, leafIndex: 0, expiry: LONG_EXPIRY, account: 3 };
const BOB = { secret: 0xb0b00000000000000000000000000000000000000000000n, country: 250n, leafIndex: 1, expiry: LONG_EXPIRY, account: 4 };
const CARLA = { secret: 0xca71a000000000000000000000000000000000000000000n, country: 724n, leafIndex: 2, expiry: Number(CURRENT_EPOCH_END), account: 6 };

const COUNTRY_LEAVES_A = [
  { leafIndex: 0, countryCode: 724 },
  { leafIndex: 1, countryCode: 250 },
];
const COUNTRY_LEAVES_B = [
  { leafIndex: 0, countryCode: 840 },
  { leafIndex: 1, countryCode: 724 },
];

function makeTree(hash, depth, leaves) {
  const zeros = [0n];
  for (let i = 0; i < depth; i++) zeros.push(hash(zeros[i], zeros[i]));

  const levels = [new Map(leaves)];
  for (let d = 0; d < depth; d++) {
    const current = levels[d];
    const next = new Map();
    for (const index of current.keys()) {
      const parent = Math.floor(index / 2);
      if (next.has(parent)) continue;
      const left = current.get(parent * 2) ?? zeros[d];
      const right = current.get(parent * 2 + 1) ?? zeros[d];
      next.set(parent, hash(left, right));
    }
    levels.push(next);
  }

  const root = levels[depth].get(0) ?? zeros[depth];

  return {
    root,
    opening(index) {
      const pathElements = [];
      const pathIndices = [];
      let cursor = index;
      for (let d = 0; d < depth; d++) {
        pathElements.push(String(levels[d].get(cursor ^ 1) ?? zeros[d]));
        pathIndices.push(String(cursor & 1));
        cursor = Math.floor(cursor / 2);
      }
      return { pathElements, pathIndices };
    },
  };
}

async function main() {
  const { buildPoseidon } = await import("circomlibjs");
  const snarkjs = await import("snarkjs");
  const { AbiCoder, HDNodeWallet, Mnemonic, getCreateAddress, keccak256 } = await import("ethers");
  const { writeFile } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");

  const here = dirname(fileURLToPath(import.meta.url));
  const build = resolve(here, CIRCUIT_BUILD);
  const wasm = `${build}/compliance_js/compliance.wasm`;
  const zkeys = { groth16: `${build}/groth16.zkey`, plonk: `${build}/plonk.zkey` };

  const mnemonic = Mnemonic.fromPhrase(HARDHAT_MNEMONIC);
  const accountAt = (index) => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`).address;
  const attestorAddress = getCreateAddress({ from: accountAt(0), nonce: ATTESTOR_DEPLOYMENT_NONCE });

  const coder = AbiCoder.defaultAbiCoder();
  const anchorFor = (sender) =>
    BigInt(keccak256(coder.encode(["address", "uint256", "address"], [sender, HARDHAT_CHAIN_ID, attestorAddress]))) %
    FIELD_ORDER;

  const poseidon = await buildPoseidon();
  const hash = (...inputs) => poseidon.F.toObject(poseidon(inputs));

  // The investor's secret never reaches the issuer: what does is Poseidon(secret),
  // and the leaf is built on that.
  const secretHashOf = (investor) => hash(investor.secret);
  const commitmentOf = (investor) => hash(secretHashOf(investor), investor.country, BigInt(investor.expiry));
  const commitments = new Map([ALICE, BOB, CARLA].map((i) => [i, commitmentOf(i)]));

  const initialTree = makeTree(hash, CREDENTIAL_DEPTH, [[ALICE.leafIndex, commitments.get(ALICE)]]);
  const currentTree = makeTree(
    hash,
    CREDENTIAL_DEPTH,
    [ALICE, BOB, CARLA].map((i) => [i.leafIndex, commitments.get(i)]),
  );

  const countryTreeA = makeTree(hash, COUNTRY_DEPTH, COUNTRY_LEAVES_A.map((l) => [l.leafIndex, BigInt(l.countryCode)]));
  const countryTreeB = makeTree(hash, COUNTRY_DEPTH, COUNTRY_LEAVES_B.map((l) => [l.leafIndex, BigInt(l.countryCode)]));

  const countryPositionA = new Map(COUNTRY_LEAVES_A.map((l) => [l.countryCode, l.leafIndex]));
  const countryPositionB = new Map(COUNTRY_LEAVES_B.map((l) => [l.countryCode, l.leafIndex]));

  const onAssetA = { countryTree: countryTreeA, countryPosition: countryPositionA, assetId: ASSET_A };
  const onAssetB = { countryTree: countryTreeB, countryPosition: countryPositionB, assetId: ASSET_B };

  const scenarios = {
    aliceCurrent: { investor: ALICE, credentialTree: currentTree, ...onAssetA },
    aliceNextPeriod: { investor: ALICE, credentialTree: currentTree, ...onAssetA, epochEnd: NEXT_EPOCH_END },
    alicePastPeriod: { investor: ALICE, credentialTree: currentTree, ...onAssetA, epochEnd: PAST_EPOCH_END },
    aliceFarFuturePeriod: { investor: ALICE, credentialTree: currentTree, ...onAssetA, epochEnd: FAR_FUTURE_EPOCH_END },
    aliceMisalignedPeriod: { investor: ALICE, credentialTree: currentTree, ...onAssetA, epochEnd: MISALIGNED_EPOCH_END },
    aliceSupersededRoot: { investor: ALICE, credentialTree: initialTree, ...onAssetA },
    aliceForeignCountryRoot: {
      investor: ALICE,
      credentialTree: currentTree,
      ...onAssetA,
      countryTree: countryTreeB,
      countryPosition: countryPositionB,
    },
    aliceOnAssetB: { investor: ALICE, credentialTree: currentTree, ...onAssetB },
    bobCurrent: { investor: BOB, credentialTree: currentTree, ...onAssetA },
    carlaCurrent: { investor: CARLA, credentialTree: currentTree, ...onAssetA },
  };

  const proofs = {};
  const plonkProofs = {};
  for (const [label, scenario] of Object.entries(scenarios)) {
    const { investor, credentialTree, countryTree, countryPosition, assetId } = scenario;
    const epochEnd = scenario.epochEnd ?? CURRENT_EPOCH_END;
    const sender = accountAt(investor.account);
    const credential = credentialTree.opening(investor.leafIndex);
    const jurisdiction = countryTree.opening(countryPosition.get(Number(investor.country)));

    const input = {
      credentialRoot: String(credentialTree.root),
      countryRoot: String(countryTree.root),
      assetId: String(assetId),
      epochEnd: String(epochEnd),
      nullifier: String(hash(investor.secret, assetId, epochEnd)),
      anchor: String(anchorFor(sender)),
      secret: String(investor.secret),
      country: String(investor.country),
      expiry: String(investor.expiry),
      credentialPathElements: credential.pathElements,
      credentialPathIndices: credential.pathIndices,
      countryPathElements: jurisdiction.pathElements,
      countryPathIndices: jurisdiction.pathIndices,
    };

    const groth16 = await snarkjs.groth16.fullProve(input, wasm, zkeys.groth16);
    const groth16Raw = await snarkjs.groth16.exportSolidityCallData(groth16.proof, groth16.publicSignals);
    const [a, b, c, signals] = JSON.parse(`[${groth16Raw}]`);
    proofs[label] = { a, b, c, signals, sender, epochEnd: String(epochEnd) };

    const plonk = await snarkjs.plonk.fullProve(input, wasm, zkeys.plonk);
    // plonk prints its two arrays with no separator between them; groth16 already has one.
    const plonkRaw = await snarkjs.plonk.exportSolidityCallData(plonk.proof, plonk.publicSignals);
    const [body, plonkSignals] = JSON.parse(`[${plonkRaw.replace(/\]\s*\[/g, "],[")}]`);
    plonkProofs[label] = { proof: body, signals: plonkSignals, sender, epochEnd: String(epochEnd) };

    console.log(`· ${label}`);
  }

  const fixture = {
    meta: {
      referenceTimestamp: NOW_TIMESTAMP,
      epochLength: EPOCH_LENGTH,
      currentEpochEnd: String(CURRENT_EPOCH_END),
      nextEpochEnd: String(NEXT_EPOCH_END),
      pastEpochEnd: String(PAST_EPOCH_END),
      farFutureEpochEnd: String(FAR_FUTURE_EPOCH_END),
      misalignedEpochEnd: String(MISALIGNED_EPOCH_END),
      assetA: String(ASSET_A),
      assetB: String(ASSET_B),
      chainId: String(HARDHAT_CHAIN_ID),
      attestorAddress,
      credentialTreeDepth: CREDENTIAL_DEPTH,
      countryTreeDepth: COUNTRY_DEPTH,
    },
    roots: {
      credentialInitial: String(initialTree.root),
      credentialCurrent: String(currentTree.root),
      countryA: String(countryTreeA.root),
      countryB: String(countryTreeB.root),
    },
    credentialLeaves: {
      initial: [{ leafIndex: ALICE.leafIndex, commitment: String(commitments.get(ALICE)) }],
      current: [BOB, CARLA].map((i) => ({ leafIndex: i.leafIndex, commitment: String(commitments.get(i)) })),
    },
    countryLeaves: { assetA: COUNTRY_LEAVES_A, assetB: COUNTRY_LEAVES_B },
    proofs,
    plonkProofs,
  };

  await writeFile(`${here}/compliance-proofs.json`, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log("· compliance-proofs.json actualizado");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
  process.exit(0);
}
