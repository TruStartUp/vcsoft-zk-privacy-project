import { time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CREDENTIAL_TREE_DEPTH, FIELD_ORDER, JURISDICTION_TREE_DEPTH } from "../../zk-api/src/lib/field";
import { SparseMerkleTree } from "../../zk-api/src/lib/merkle";
import { poseidonHash, type HashFn } from "../../zk-api/src/lib/poseidon";
import { proofBody } from "./helpers";
import {
  deployPublished,
  deployTrexSuite,
  publishedArtifacts,
  publishedInterfaces,
  type TrexSuite,
} from "./trex-suite";

const snarkjs = require("snarkjs");

/// The confidentiality layer against the real thing.
///
/// Everything below runs on a full T-REX deployment built from the bytecode the
/// ERC-3643 organisation publishes -- token, identity registry and its storage,
/// modular compliance, trusted issuers and claim topics -- with
/// `ZKComplianceModule` added to that compliance as one more module. No
/// ModularCompliance stand-in takes part.
///
/// The trees and the Poseidon permutation are imported from `zk-api`, so the
/// leaves this suite builds are the leaves the issuer service builds. What is
/// rebuilt here is only the EIP-712 activation domain, because `zk-api` reads it
/// from a service configuration that needs a database, a Redis and a key set,
/// and because the registry address it names is not known until this deployment
/// happens.

const CIRCUIT_BUILD = resolve(__dirname, "../../zk-circuits/build");
const CIRCUIT_WASM = `${CIRCUIT_BUILD}/compliance_js/compliance.wasm`;
const CIRCUIT_ZKEY = `${CIRCUIT_BUILD}/groth16.zkey`;
const CIRCUIT_SOURCE = resolve(__dirname, "../../zk-circuits/circuits/compliance.circom");

const REFERENCE_TIMESTAMP = Math.floor(Date.UTC(2040, 0, 1) / 1000);
const EPOCH_LENGTH = 30 * 24 * 60 * 60;
const ROOT_VALIDITY_WINDOW = 15 * 60;
const CREDENTIAL_EXPIRY = Math.floor(Date.UTC(2050, 0, 1) / 1000);

const ASSET_ID = 3643n;
const SPAIN = 724;
const FRANCE = 250;
const UNITED_STATES = 840;
const ADMITTED_JURISDICTIONS = [SPAIN, FRANCE];

const MINT_AMOUNT = 1_000n * 10n ** 18n;
const TRANSFER_AMOUNT = 250n * 10n ** 18n;

const ACTIVATION_DOMAIN_NAME = "VCSoft Confidentiality Layer";
const ACTIVATION_DOMAIN_VERSION = "1";
const ACTIVATION_TYPES = {
  CredentialActivation: [
    { name: "credentialId", type: "string" },
    { name: "secretHash", type: "string" },
  ],
};

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/// Fixed rather than sampled: the reference implementation draws the secret
/// uniformly from the field (`randomHolderSecret`), and pinning it here only
/// makes a failing run reproducible.
const HOLDERS = {
  alice: { secret: 0xa11ce00000000000000000000000000000000000000001n, country: SPAIN },
  bruno: { secret: 0xb00000000000000000000000000000000000000000000002n, country: FRANCE },
  carmen: { secret: 0xca00000000000000000000000000000000000000000003n, country: SPAIN },
  dario: { secret: 0xda00000000000000000000000000000000000000000004n, country: UNITED_STATES },
  elena: { secret: 0xe1e00000000000000000000000000000000000000000005n, country: SPAIN },
  fabio: { secret: 0xfab00000000000000000000000000000000000000000006n, country: SPAIN },
};

type HolderName = keyof typeof HOLDERS;

interface Credential {
  id: string;
  holder: Signer;
  country: number;
  expiry: number;
  status: "PENDING" | "ACTIVE" | "REVOKED";
  secret: bigint;
  secretHash?: bigint;
  commitment?: bigint;
  leafIndex?: number;
}

const gasSpent = new Map<string, bigint>();
const record = async (label: string, tx: { wait(): Promise<any> }) => {
  const receipt = await tx.wait();
  gasSpent.set(label, receipt.gasUsed);
  return receipt;
};

/// The issuing desk, in the two steps `zk-api` splits issuance into: the KYC
/// verdict is recorded with nothing published, and only when the holder hands
/// over the hash of a secret the desk never sees -- with a signature proving the
/// wallet that passed the identity check is the one handing it over -- is the
/// leaf built and the root published.
class IssuingDesk {
  readonly tree: SparseMerkleTree;
  private nextLeafIndex = 0;

  constructor(
    private readonly hash: HashFn,
    private readonly registry: any,
    private readonly issuer: Signer,
    private readonly domain: { name: string; version: string; chainId: number; verifyingContract: string },
  ) {
    this.tree = new SparseMerkleTree(CREDENTIAL_TREE_DEPTH, hash);
  }

  root(): bigint {
    return this.tree.root();
  }

  recordVerdict(name: HolderName, holder: Signer): Credential {
    return {
      id: `cred-${name}`,
      holder,
      country: HOLDERS[name].country,
      expiry: CREDENTIAL_EXPIRY,
      status: "PENDING",
      secret: HOLDERS[name].secret,
    };
  }

  activationMessage(credential: Credential, secretHash: bigint) {
    return { credentialId: credential.id, secretHash: secretHash.toString() };
  }

  async signActivation(credential: Credential, secretHash: bigint, signedBy: Signer) {
    return signedBy.signTypedData(this.domain, ACTIVATION_TYPES, this.activationMessage(credential, secretHash));
  }

  /// The holder's half of the activation. The secret stays in this object and
  /// never reaches the desk; what travels is the hash and the signature.
  async activate(credential: Credential, signedBy: Signer = credential.holder) {
    const secretHash = this.hash(credential.secret);
    const signature = await this.signActivation(credential, secretHash, signedBy);
    const message = this.activationMessage(credential, secretHash);
    const signer = ethers.verifyTypedData(this.domain, ACTIVATION_TYPES, message, signature);
    if (signer !== credential.holder.address) {
      throw new Error("holder_possession_not_proven");
    }

    const commitment = this.hash(secretHash, BigInt(credential.country), BigInt(credential.expiry));
    const leafIndex = this.nextLeafIndex;
    this.nextLeafIndex += 1;
    this.tree.setLeaf(leafIndex, commitment);

    const tx = await this.registry
      .connect(this.issuer)
      .publishCredentialRoot(this.tree.root(), [{ leafIndex, commitment, inserted: true }]);
    const receipt = await record("emisión · publishCredentialRoot (activación)", tx);

    credential.status = "ACTIVE";
    credential.secretHash = secretHash;
    credential.commitment = commitment;
    credential.leafIndex = leafIndex;
    return { receipt, root: this.tree.root() };
  }

  /// Revocation takes the leaf out and publishes the root without it, and then
  /// closes the window in which the superseded root is still acceptable. Both
  /// halves matter: without the second one the removed credential keeps proving
  /// membership for `rootValidityWindow`.
  async revoke(credential: Credential) {
    const supersededRoot = this.tree.root();
    this.tree.clearLeaf(credential.leafIndex!);

    const publish = await this.registry
      .connect(this.issuer)
      .publishCredentialRoot(this.tree.root(), [
        { leafIndex: credential.leafIndex!, commitment: credential.commitment!, inserted: false },
      ]);
    const publishReceipt = await record("revocación · publishCredentialRoot", publish);

    const invalidate = await this.registry.connect(this.issuer).invalidateCredentialRoot(supersededRoot);
    const invalidateReceipt = await record("revocación · invalidateCredentialRoot", invalidate);

    credential.status = "REVOKED";
    return { supersededRoot, publishReceipt, invalidateReceipt };
  }
}

interface Stack {
  owner: Signer;
  tokenAgent: Signer;
  intruder: Signer;
  platform: Signer;
  trex: TrexSuite;
  registry: any;
  attestor: any;
  module: any;
  moduleAddress: string;
  complianceAddress: string;
  desk: IssuingDesk;
  jurisdictionTree: SparseMerkleTree;
  credentials: Record<HolderName, Credential>;
  wallets: Record<HolderName, Signer>;
  hash: HashFn;
}

/// Every stack is deployed from scratch rather than restored from a snapshot:
/// the trees and the credentials live in this process and would not travel back
/// with an `evm_revert`, so a snapshot would leave chain state and issuer state
/// disagreeing. Tests that spend a period move the clock forward and never back,
/// which is why the reference instant is only reached once.
async function deployStack(): Promise<Stack> {
  const [owner, tokenAgent, claimIssuerOwner, claimSigningKey, issuer, jurisdictionOfficer, intruder,
    alice, bruno, carmen, dario, elena, fabio, platform] = await ethers.getSigners();
  if ((await time.latest()) < REFERENCE_TIMESTAMP) await time.increaseTo(REFERENCE_TIMESTAMP);

  const trex = await deployTrexSuite({ owner, tokenAgent, claimIssuerOwner, claimSigningKey });

  const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(
    owner.address,
    ROOT_VALIDITY_WINDOW,
  );
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const groth16Adapter = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(
    await verifier.getAddress(),
  );
  const attestor = await (await ethers.getContractFactory("ComplianceAttestor")).deploy(
    owner.address,
    await registry.getAddress(),
    await groth16Adapter.getAddress(),
    EPOCH_LENGTH,
  );

  await registry.grantRole(await registry.ISSUER_ROLE(), issuer.address);
  await registry.grantRole(await registry.JURISDICTION_ROLE(), jurisdictionOfficer.address);
  await attestor.grantRole(await attestor.ATTESTATION_MANAGER_ROLE(), owner.address);

  /// Deployed the way a T-REX module is deployed: an implementation behind the
  /// standard's own ModuleProxy, initialised in the same transaction.
  const implementation = await (await ethers.getContractFactory("ZKComplianceModule")).deploy();
  const proxy = await deployPublished(
    publishedArtifacts.ModuleProxy,
    owner,
    await implementation.getAddress(),
    implementation.interface.encodeFunctionData("initialize", [await attestor.getAddress()]),
  );
  const module = implementation.attach(await proxy.getAddress()) as any;
  const moduleAddress = await module.getAddress();
  const complianceAddress = await trex.compliance.getAddress();

  await record("enganche · compliance.addModule", await trex.compliance.addModule(moduleAddress));
  await record(
    "enganche · compliance.callModuleFunction(setAssetId)",
    await trex.compliance.callModuleFunction(
      module.interface.encodeFunctionData("setAssetId", [ASSET_ID]),
      moduleAddress,
    ),
  );

  const hash = await poseidonHash();

  const jurisdictionTree = SparseMerkleTree.from(
    JURISDICTION_TREE_DEPTH,
    hash,
    ADMITTED_JURISDICTIONS.map((code, index) => [index, BigInt(code)] as [number, bigint]),
  );
  await record(
    "jurisdicciones · publishCountryRoot",
    await registry
      .connect(jurisdictionOfficer)
      .publishCountryRoot(
        ASSET_ID,
        jurisdictionTree.root(),
        ADMITTED_JURISDICTIONS.map((code, index) => ({ leafIndex: index, countryCode: code, admitted: true })),
      ),
  );

  const { chainId } = await ethers.provider.getNetwork();
  const desk = new IssuingDesk(hash, registry, issuer, {
    name: ACTIVATION_DOMAIN_NAME,
    version: ACTIVATION_DOMAIN_VERSION,
    chainId: Number(chainId),
    verifyingContract: await registry.getAddress(),
  });

  const wallets = { alice, bruno, carmen, dario, elena, fabio };
  const credentials = Object.fromEntries(
    (Object.keys(HOLDERS) as HolderName[]).map((name) => [name, desk.recordVerdict(name, wallets[name])]),
  ) as Record<HolderName, Credential>;

  /// Everyone but Elena is an investor as ERC-3643 understands one. Elena is the
  /// case that shows the layer adds a condition instead of replacing one: she
  /// will hold a live attestation and still not be able to receive.
  for (const name of ["alice", "bruno", "carmen", "dario", "fabio"] as HolderName[]) {
    await trex.registerInvestor(wallets[name], HOLDERS[name].country);
  }

  /// Fabio's credential is left on the desk, recorded and unpublished, so the
  /// two steps of issuance can be walked separately.
  for (const name of ["alice", "bruno", "carmen", "dario", "elena"] as HolderName[]) {
    await desk.activate(credentials[name]);
  }

  return {
    owner,
    tokenAgent,
    intruder,
    platform,
    trex,
    registry,
    attestor,
    module,
    moduleAddress,
    complianceAddress,
    desk,
    jurisdictionTree,
    credentials,
    wallets,
    hash,
  };
}

interface ProofRequest {
  epochEnd?: bigint;
  jurisdictionLeafIndex?: number;
}

function circuitInput(stack: Stack, credential: Credential, epochEnd: bigint, anchor: bigint, jurisdictionLeafIndex: number) {
  const credentialOpening = stack.desk.tree.opening(credential.leafIndex!);
  const jurisdictionOpening = stack.jurisdictionTree.opening(jurisdictionLeafIndex);
  return {
    credentialRoot: String(stack.desk.root()),
    countryRoot: String(stack.jurisdictionTree.root()),
    assetId: String(ASSET_ID),
    epochEnd: String(epochEnd),
    nullifier: String(stack.hash(credential.secret, ASSET_ID, epochEnd)),
    anchor: String(anchor),
    secret: String(credential.secret),
    country: String(credential.country),
    expiry: String(credential.expiry),
    credentialPathElements: credentialOpening.pathElements,
    credentialPathIndices: credentialOpening.pathIndices,
    countryPathElements: jurisdictionOpening.pathElements,
    countryPathIndices: jurisdictionOpening.pathIndices,
  };
}

/// The holder's side: a real Groth16 proof over the compiled circuit, against
/// the roots the registry holds right now and anchored to the holder's address,
/// whoever ends up sending it.
async function proveCompliance(stack: Stack, credential: Credential, request: ProofRequest = {}) {
  const epochEnd = request.epochEnd ?? (await stack.attestor.currentEpochEnd());
  const anchor = await stack.attestor.anchorFor(credential.holder.address);
  const jurisdictionLeafIndex =
    request.jurisdictionLeafIndex ?? ADMITTED_JURISDICTIONS.indexOf(credential.country);

  const input = circuitInput(stack, credential, epochEnd, anchor, jurisdictionLeafIndex);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, CIRCUIT_WASM, CIRCUIT_ZKEY);
  const [a, b, c, signals] = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  return { a, b, c, signals, epochEnd, anchor };
}

/// The platform's side: it presents the holder's proof and pays for it. The holder
/// sends nothing.
async function presentForHolder(stack: Stack, credential: Credential, request: ProofRequest = {}) {
  const proof = await proveCompliance(stack, credential, request);
  const tx = await stack.attestor
    .connect(stack.platform)
    .attestFor(credential.holder.address, proofBody(proof), proof.signals);
  return { proof, receipt: await tx.wait() };
}

const circuitSource = readFileSync(CIRCUIT_SOURCE, "utf8").split("\n");
function circuitLineOf(fragment: string): number {
  const index = circuitSource.findIndex((line) => line.includes(fragment));
  expect(index, `no line of compliance.circom contains "${fragment}"`).to.be.greaterThanOrEqual(0);
  return index + 1;
}

/// Witness generation aborts on the first unsatisfied constraint and names the
/// line that reached it, so a refusal can be pinned to the predicate it was
/// meant to break instead of to any predicate at all.
async function refusedByTheCircuitAt(promise: Promise<unknown>, fragment: string) {
  const line = circuitLineOf(fragment);
  const chatter = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  let message: string | undefined;
  try {
    await promise;
  } catch (error) {
    message = (error as Error).message;
  } finally {
    Object.assign(console, chatter);
  }
  expect(message, "the circuit produced a proof it must refuse").to.be.a("string");
  expect(message).to.match(new RegExp(`Compliance\\w* line: ${line}\\b`));
}

/// The assertion this whole suite lives or dies by.
///
/// `Token.transfer` reverts with "Transfer not possible" whether the receiver
/// failed the identity check or the compliance check, and `mint` reverts with
/// "Compliance not followed" for any module that says no. Neither message
/// identifies who refused, so a test that only watched for the revert would pass
/// for the wrong reason as soon as an unrelated rule started blocking.
///
/// So the refusal is attributed instead of assumed: every rule of the standard
/// that could have blocked is shown to be satisfied, the ZK module is shown to
/// be the one answering false, and the same operation is then replayed with the
/// module unhooked from the compliance -- where it must go through.
async function refusalIsTheZkModules(
  stack: Stack,
  from: string,
  to: string,
  amount: bigint,
  operation: () => Promise<unknown>,
  revertReason: string,
) {
  const { token, identityRegistry, compliance } = stack.trex;

  expect(await identityRegistry.isVerified(to), "el estándar da por verificado al receptor").to.equal(true);
  expect(await token.paused(), "el token no está en pausa").to.equal(false);
  expect(await token.isFrozen(to), "el receptor no está congelado").to.equal(false);
  if (from !== ethers.ZeroAddress) {
    expect(await identityRegistry.isVerified(from), "el estándar da por verificado al emisor").to.equal(true);
    expect(await token.isFrozen(from), "el emisor no está congelado").to.equal(false);
    expect(await token.getFrozenTokens(from), "el emisor no tiene saldo congelado").to.equal(0n);
    expect((await token.balanceOf(from)) >= amount, "el emisor tiene saldo suficiente").to.equal(true);
  }

  expect([...(await compliance.getModules())], "el módulo ZK es el único módulo enganchado").to.deep.equal([
    stack.moduleAddress,
  ]);
  expect(await stack.module.moduleCheck(from, to, amount, stack.complianceAddress), "el módulo ZK deniega").to.equal(
    false,
  );
  expect(await compliance.canTransfer(from, to, amount), "la compliance deniega").to.equal(false);

  await expect(operation()).to.be.revertedWith(revertReason);

  await compliance.connect(stack.owner).removeModule(stack.moduleAddress);
  expect([...(await compliance.getModules())]).to.deep.equal([]);
  expect(
    await compliance.canTransfer(from, to, amount),
    "sin el módulo ZK la misma operación cumple, así que el rechazo era suyo",
  ).to.equal(true);
  await expect(operation()).to.not.be.reverted;
}

describe("Integración con la suite T-REX real", function () {
  this.timeout(600000);

  let stack: Stack;

  beforeEach(async () => {
    stack = await deployStack();
  });

  after(async () => {
    const curve = await snarkjs.curves.getCurveFromR(FIELD_ORDER);
    await curve.terminate();

    const rows = [...gasSpent.entries()].map(([label, gas]) => `  ${label.padEnd(52)} ${gas.toString().padStart(9)}`);
    console.log(`\n  Gas de las operaciones del ciclo\n${rows.join("\n")}\n`);
  });

  describe("el despliegue", () => {
    it("es la suite del estándar y no un doble", async () => {
      const { token, identityRegistry, identityRegistryStorage, compliance, claimTopicsRegistry } = stack.trex;

      expect(await token.name()).to.equal("VCSoft Tokenized Asset");
      expect(await token.version()).to.equal("4.1.3");
      expect(await token.identityRegistry()).to.equal(await identityRegistry.getAddress());
      expect(await token.compliance()).to.equal(stack.complianceAddress);
      expect(await compliance.getTokenBound()).to.equal(await token.getAddress());
      expect(await identityRegistry.identityStorage()).to.equal(await identityRegistryStorage.getAddress());
      expect((await claimTopicsRegistry.getClaimTopics()).length).to.equal(1);

      const authority = await stack.trex.implementationAuthority.getAddress();
      const proxies = {
        token: await token.getAddress(),
        identityRegistry: await identityRegistry.getAddress(),
        compliance: stack.complianceAddress,
      };
      for (const [role, address] of Object.entries(proxies)) {
        const proxy = new ethers.Contract(address, publishedInterfaces.IProxy.abi, stack.owner);
        expect(await proxy.getImplementationAuthority(), role).to.equal(authority);
      }
      expect(await stack.trex.implementationAuthority.getTokenImplementation()).to.not.equal(ethers.ZeroAddress);
    });

    it("engancha el módulo ZK a la ModularCompliance del token, ligado al activo", async () => {
      expect([...(await stack.trex.compliance.getModules())]).to.deep.equal([stack.moduleAddress]);
      expect(await stack.trex.compliance.isModuleBound(stack.moduleAddress)).to.equal(true);
      expect(await stack.module.isComplianceBound(stack.complianceAddress)).to.equal(true);
      expect(await stack.module.assetIdOf(stack.complianceAddress)).to.equal(ASSET_ID);
      expect(await stack.module.complianceOfAsset(ASSET_ID)).to.equal(stack.complianceAddress);
      expect(await stack.module.attestor()).to.equal(await stack.attestor.getAddress());
    });

    it("los inversores están verificados por el estándar antes de que la capa diga nada", async () => {
      const { identityRegistry } = stack.trex;

      for (const name of ["alice", "bruno", "carmen", "dario", "fabio"] as HolderName[]) {
        expect(await identityRegistry.isVerified(stack.wallets[name].address), name).to.equal(true);
      }
      expect(await identityRegistry.investorCountry(stack.wallets.alice.address)).to.equal(SPAIN);
      expect(await identityRegistry.isVerified(stack.wallets.elena.address)).to.equal(false);
    });
  });

  describe("el ciclo, paso a paso", () => {
    it("1 · la emisión en dos tiempos no publica nada hasta que el titular aporta su hash", async () => {
      const fabio = stack.credentials.fabio;
      const rootBefore = await stack.registry.credentialRoot();

      expect(fabio.status).to.equal("PENDING");
      expect(fabio.commitment).to.equal(undefined);
      expect(fabio.leafIndex).to.equal(undefined);

      const { receipt, root } = await stack.desk.activate(fabio);

      expect(fabio.status).to.equal("ACTIVE");
      expect(fabio.commitment).to.equal(stack.hash(stack.hash(fabio.secret), BigInt(SPAIN), BigInt(CREDENTIAL_EXPIRY)));
      expect(await stack.registry.credentialRoot()).to.equal(root);
      expect(root).to.not.equal(rootBefore);
      expect(await stack.registry.isCredentialRootValid(rootBefore)).to.equal(true);

      const leafEvents = await stack.registry.queryFilter(
        stack.registry.filters.CredentialLeafUpdated(),
        receipt.blockNumber,
        receipt.blockNumber,
      );
      expect(leafEvents.length).to.equal(1);
      expect(leafEvents[0].args.commitment).to.equal(fabio.commitment);
      expect(leafEvents[0].args.inserted).to.equal(true);
    });

    it("2 · la activación exige la firma de posesión del titular, no la de la mesa", async () => {
      const fabio = stack.credentials.fabio;
      const rootBefore = await stack.registry.credentialRoot();

      await expect(stack.desk.activate(fabio, stack.intruder)).to.be.rejectedWith("holder_possession_not_proven");
      expect(await stack.registry.credentialRoot()).to.equal(rootBefore);
      expect(fabio.status).to.equal("PENDING");
    });

    it("3 · la raíz de jurisdicciones del activo está publicada y es la que la prueba usa", async () => {
      expect(await stack.registry.countryRootOf(ASSET_ID)).to.equal(stack.jurisdictionTree.root());
      expect(await stack.registry.isCountryRootValid(ASSET_ID, stack.jurisdictionTree.root())).to.equal(true);
      expect(stack.jurisdictionTree.leafAt(0)).to.equal(BigInt(SPAIN));
      expect(stack.jurisdictionTree.leafAt(1)).to.equal(BigInt(FRANCE));
    });

    it("4 · el titular construye su prueba y la plataforma la presenta; anclada a otro no sirve", async () => {
      const alice = stack.credentials.alice;
      const epochEnd = await stack.attestor.currentEpochEnd();
      const proof = await proveCompliance(stack, alice, { epochEnd });

      expect(proof.signals, "el orden de las seis señales públicas es el que el contrato lee").to.deep.equal([
        String(stack.desk.root()),
        String(stack.jurisdictionTree.root()),
        String(ASSET_ID),
        String(epochEnd),
        String(stack.hash(alice.secret, ASSET_ID, epochEnd)),
        String(proof.anchor),
      ]);
      expect(proof.anchor).to.equal(await stack.attestor.anchorFor(alice.holder.address));

      await expect(
        stack.attestor.connect(stack.intruder).attest(proofBody(proof), proof.signals),
      ).to.be.revertedWithCustomError(stack.attestor, "AnchorMismatch");
      await expect(
        stack.attestor
          .connect(stack.platform)
          .attestFor(stack.wallets.bruno.address, proofBody(proof), proof.signals),
      ).to.be.revertedWithCustomError(stack.attestor, "AnchorMismatch");

      const holderNonce = await ethers.provider.getTransactionCount(alice.holder.address);
      const holderBalance = await ethers.provider.getBalance(alice.holder.address);

      const tx = await stack.attestor
        .connect(stack.platform)
        .attestFor(alice.holder.address, proofBody(proof), proof.signals);
      await expect(tx)
        .to.emit(stack.attestor, "ComplianceAttested")
        .withArgs(ASSET_ID, alice.holder.address, proof.signals[4], anyValue, epochEnd);
      const receipt = await record("atestación · attestFor (la presenta la plataforma)", tx);

      expect(receipt.from, "la transacción la firma y la paga la plataforma").to.equal(stack.platform.address);
      expect(await ethers.provider.getTransactionCount(alice.holder.address), "el titular no envía nada").to.equal(
        holderNonce,
      );
      expect(await ethers.provider.getBalance(alice.holder.address), "ni paga gas").to.equal(holderBalance);

      expect(await stack.attestor.isAttested(ASSET_ID, alice.holder.address)).to.equal(true);
      expect(await stack.attestor.isAttested(ASSET_ID, stack.platform.address)).to.equal(false);
      expect(await stack.attestor.attestationExpiry(ASSET_ID, alice.holder.address)).to.equal(epochEnd);
      expect(await stack.attestor.isNullifierSpent(proof.signals[4])).to.equal(true);

      await expect(
        stack.attestor.connect(alice.holder).attest(proofBody(proof), proof.signals),
      ).to.be.revertedWithCustomError(stack.attestor, "NullifierAlreadySpent");
    });

    it("4 bis · el titular conserva la vía directa si nadie presenta por él", async () => {
      const bruno = stack.credentials.bruno;
      const proof = await proveCompliance(stack, bruno);

      const tx = await stack.attestor.connect(bruno.holder).attest(proofBody(proof), proof.signals);
      await expect(tx)
        .to.emit(stack.attestor, "ComplianceAttested")
        .withArgs(ASSET_ID, bruno.holder.address, proof.signals[4], anyValue, proof.epochEnd);
      await record("atestación · attest (la presenta el titular)", tx);

      expect(await stack.attestor.isAttested(ASSET_ID, bruno.holder.address)).to.equal(true);
    });

    it("5 · el token T-REX acuña al titular porque moduleCheck encuentra la atestación", async () => {
      const alice = stack.credentials.alice;
      const { token, compliance } = stack.trex;

      expect(await compliance.canTransfer(ethers.ZeroAddress, alice.holder.address, MINT_AMOUNT)).to.equal(false);
      await presentForHolder(stack, alice);
      expect(await compliance.canTransfer(ethers.ZeroAddress, alice.holder.address, MINT_AMOUNT)).to.equal(true);
      expect(
        await stack.module.moduleCheck(ethers.ZeroAddress, alice.holder.address, MINT_AMOUNT, stack.complianceAddress),
      ).to.equal(true);

      const tx = await token.connect(stack.tokenAgent).mint(alice.holder.address, MINT_AMOUNT);
      await record("token T-REX · mint", tx);

      expect(await token.balanceOf(alice.holder.address)).to.equal(MINT_AMOUNT);
      expect(await token.totalSupply()).to.equal(MINT_AMOUNT);
    });

    it("6 · una transferencia entre titulares atestados atraviesa el módulo y se completa", async () => {
      const { alice, bruno } = stack.credentials;
      const { token } = stack.trex;

      await presentForHolder(stack, alice);
      await presentForHolder(stack, bruno);
      await token.connect(stack.tokenAgent).mint(alice.holder.address, MINT_AMOUNT);

      const tx = await token.connect(alice.holder).transfer(bruno.holder.address, TRANSFER_AMOUNT);
      await record("token T-REX · transfer", tx);

      expect(await token.balanceOf(bruno.holder.address)).to.equal(TRANSFER_AMOUNT);
      expect(await token.balanceOf(alice.holder.address)).to.equal(MINT_AMOUNT - TRANSFER_AMOUNT);
    });

    it("7 · revocar la credencial cierra la emisión de atestaciones nuevas", async () => {
      const alice = stack.credentials.alice;
      const nextEpochEnd = (await stack.attestor.currentEpochEnd()) + BigInt(EPOCH_LENGTH);

      await presentForHolder(stack, alice);
      const renewal = await proveCompliance(stack, alice, { epochEnd: nextEpochEnd });

      const { supersededRoot } = await stack.desk.revoke(alice);

      expect(alice.status).to.equal("REVOKED");
      expect(stack.desk.tree.leafAt(alice.leafIndex!)).to.equal(undefined);
      expect(await stack.registry.credentialRoot()).to.equal(stack.desk.root());
      expect(await stack.registry.isCredentialRootValid(supersededRoot)).to.equal(false);

      await expect(
        stack.attestor.connect(stack.platform).attestFor(alice.holder.address, proofBody(renewal), renewal.signals),
      )
        .to.be.revertedWithCustomError(stack.attestor, "CredentialRootNotValid")
        .withArgs(supersededRoot);

      await refusedByTheCircuitAt(
        proveCompliance(stack, alice, { epochEnd: nextEpochEnd }),
        "inRegistry.root === credentialRoot",
      );
    });

    it("8 · cortar la atestación viva bloquea la entrega, y el rechazo es del módulo", async () => {
      const { alice, bruno } = stack.credentials;
      const { token } = stack.trex;

      await presentForHolder(stack, alice);
      await presentForHolder(stack, bruno);
      await token.connect(stack.tokenAgent).mint(bruno.holder.address, MINT_AMOUNT);

      await stack.desk.revoke(alice);
      const cut = await stack.attestor.connect(stack.owner).revokeAttestation(ASSET_ID, alice.holder.address);
      await record("atestación · revokeAttestation", cut);

      expect(await stack.attestor.isAttested(ASSET_ID, alice.holder.address)).to.equal(false);

      await refusalIsTheZkModules(
        stack,
        bruno.holder.address,
        alice.holder.address,
        TRANSFER_AMOUNT,
        () => token.connect(bruno.holder).transfer(alice.holder.address, TRANSFER_AMOUNT),
        "Transfer not possible",
      );
    });
  });

  describe("el cumplimiento no se relaja", () => {
    it("un titular sin atestación no recibe", async () => {
      const carmen = stack.credentials.carmen;
      const { token } = stack.trex;

      expect(await stack.attestor.isAttested(ASSET_ID, carmen.holder.address)).to.equal(false);

      await refusalIsTheZkModules(
        stack,
        ethers.ZeroAddress,
        carmen.holder.address,
        MINT_AMOUNT,
        () => token.connect(stack.tokenAgent).mint(carmen.holder.address, MINT_AMOUNT),
        "Compliance not followed",
      );
    });

    it("un titular cuya atestación caducó tampoco recibe", async () => {
      const alice = stack.credentials.alice;
      const { token } = stack.trex;

      const { proof } = await presentForHolder(stack, alice);
      await time.increaseTo(Number(proof.epochEnd) - 1);
      expect(await stack.attestor.isAttested(ASSET_ID, alice.holder.address)).to.equal(true);

      await time.increaseTo(Number(proof.epochEnd));
      expect(await stack.attestor.isAttested(ASSET_ID, alice.holder.address)).to.equal(false);
      expect(await stack.attestor.attestationExpiry(ASSET_ID, alice.holder.address)).to.equal(proof.epochEnd);

      await refusalIsTheZkModules(
        stack,
        ethers.ZeroAddress,
        alice.holder.address,
        MINT_AMOUNT,
        () => token.connect(stack.tokenAgent).mint(alice.holder.address, MINT_AMOUNT),
        "Compliance not followed",
      );
    });

    it("una jurisdicción no admitida no llega ni a obtener atestación", async () => {
      const dario = stack.credentials.dario;
      const { token, identityRegistry } = stack.trex;

      expect(await identityRegistry.isVerified(dario.holder.address)).to.equal(true);
      expect(await identityRegistry.investorCountry(dario.holder.address)).to.equal(UNITED_STATES);
      expect(ADMITTED_JURISDICTIONS).to.not.include(UNITED_STATES);

      await refusedByTheCircuitAt(
        proveCompliance(stack, dario, { jurisdictionLeafIndex: 0 }),
        "inAllowed.root === countryRoot",
      );

      expect(await stack.attestor.isAttested(ASSET_ID, dario.holder.address)).to.equal(false);
      await refusalIsTheZkModules(
        stack,
        ethers.ZeroAddress,
        dario.holder.address,
        MINT_AMOUNT,
        () => token.connect(stack.tokenAgent).mint(dario.holder.address, MINT_AMOUNT),
        "Compliance not followed",
      );
    });

    it("una atestación no sustituye a la identidad verificada que exige el estándar", async () => {
      const elena = stack.credentials.elena;
      const { token, identityRegistry, compliance } = stack.trex;

      await presentForHolder(stack, elena);

      expect(await stack.attestor.isAttested(ASSET_ID, elena.holder.address)).to.equal(true);
      expect(await compliance.canTransfer(ethers.ZeroAddress, elena.holder.address, MINT_AMOUNT)).to.equal(true);
      expect(await identityRegistry.isVerified(elena.holder.address)).to.equal(false);

      await expect(
        token.connect(stack.tokenAgent).mint(elena.holder.address, MINT_AMOUNT),
      ).to.be.revertedWith("Identity is not verified.");

      await compliance.connect(stack.owner).removeModule(stack.moduleAddress);
      await expect(
        token.connect(stack.tokenAgent).mint(elena.holder.address, MINT_AMOUNT),
      ).to.be.revertedWith("Identity is not verified.");
    });

    it("el módulo condiciona a quien recibe, no a quien envía", async () => {
      const { alice, bruno } = stack.credentials;
      const { token } = stack.trex;

      await presentForHolder(stack, alice);
      await presentForHolder(stack, bruno);
      await token.connect(stack.tokenAgent).mint(alice.holder.address, MINT_AMOUNT);

      await stack.attestor.connect(stack.owner).revokeAttestation(ASSET_ID, alice.holder.address);
      expect(await stack.attestor.isAttested(ASSET_ID, alice.holder.address)).to.equal(false);

      await expect(token.connect(alice.holder).transfer(bruno.holder.address, TRANSFER_AMOUNT)).to.not.be.reverted;
      expect(await token.balanceOf(bruno.holder.address)).to.equal(TRANSFER_AMOUNT);
    });
  });

  describe("la prueba no se engaña a sí misma", () => {
    it("desenganchar el módulo deja pasar lo que la suite afirma bloqueado", async () => {
      const carmen = stack.credentials.carmen;
      const { token, compliance } = stack.trex;

      expect(await compliance.canTransfer(ethers.ZeroAddress, carmen.holder.address, MINT_AMOUNT)).to.equal(false);

      await compliance.connect(stack.owner).removeModule(stack.moduleAddress);

      expect([...(await compliance.getModules())]).to.deep.equal([]);
      expect(await compliance.canTransfer(ethers.ZeroAddress, carmen.holder.address, MINT_AMOUNT)).to.equal(true);
      await token.connect(stack.tokenAgent).mint(carmen.holder.address, MINT_AMOUNT);
      expect(await token.balanceOf(carmen.holder.address)).to.equal(MINT_AMOUNT);
    });

    it("con el módulo enganchado y sin atestación, la misma operación no pasa", async () => {
      const carmen = stack.credentials.carmen;
      const { token, compliance } = stack.trex;

      expect([...(await compliance.getModules())]).to.deep.equal([stack.moduleAddress]);
      await expect(token.connect(stack.tokenAgent).mint(carmen.holder.address, MINT_AMOUNT)).to.be.revertedWith(
        "Compliance not followed",
      );
      expect(await token.balanceOf(carmen.holder.address)).to.equal(0n);
    });

    it("el módulo apuntado a otro activo deja de reconocer la atestación", async () => {
      const alice = stack.credentials.alice;
      const { compliance } = stack.trex;

      await presentForHolder(stack, alice);
      expect(await compliance.canTransfer(ethers.ZeroAddress, alice.holder.address, MINT_AMOUNT)).to.equal(true);

      await compliance
        .connect(stack.owner)
        .callModuleFunction(stack.module.interface.encodeFunctionData("setAssetId", [ASSET_ID + 1n]), stack.moduleAddress);

      expect(await stack.module.assetIdOf(stack.complianceAddress)).to.equal(ASSET_ID + 1n);
      expect(await compliance.canTransfer(ethers.ZeroAddress, alice.holder.address, MINT_AMOUNT)).to.equal(false);
    });
  });
});
