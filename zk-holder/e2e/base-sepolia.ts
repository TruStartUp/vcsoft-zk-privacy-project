import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseEventLogs,
  parseUnits,
  stringToHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hash,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

import { complianceAttestorAbi, readProvingContext } from "../src/chain.js";
import { credentialCommitment, expiryOf } from "../src/credential.js";
import { PartnerClient, type ApiResponse } from "../src/partner-client.js";
import { holderDomain, recoverActivationSigner, sameDomain, signActivation } from "../src/possession.js";
import { presentForSubject, revertName } from "../src/presenter.js";
import {
  attestorArguments,
  circuitArtifacts,
  proveCompliance,
  releaseProver,
  verifyLocally,
  type Groth16CallData,
} from "../src/prover.js";
import {
  generateHolderSecret,
  holderSecretHash,
  openHolderSecret,
  sealHolderSecret,
  type HolderSecretBackup,
} from "../src/secret.js";
import { buildWitness, WitnessError, type CredentialOpeningResponse, type JurisdictionOpeningResponse } from "../src/witness.js";
import {
  Log,
  StopError,
  Store,
  basescanTx,
  check,
  eth,
  receiptRecord,
  type E2EState,
  type InvestorRecord,
  type PartnerRecord,
  type TxRecord,
} from "./support.js";

const REPO = resolve(import.meta.dirname, "../..");
const STATE_PATH = resolve(import.meta.dirname, "state/base-sepolia.json");
const LOG_PATH = resolve(REPO, `docs/evidencias/${new Date().toISOString().slice(0, 10)}_e2e_base-sepolia_ciclo-completo.log`);
const ARTIFACTS = circuitArtifacts(resolve(REPO, "zk-circuits/build"));

const deployment = JSON.parse(readFileSync(resolve(REPO, "zk-contracts/deployments/baseSepolia.json"), "utf8")) as {
  chainId: number;
  parameters: { assetId: string; deployer: Address; platform: Address };
  external: { claimIssuer: Address };
  contracts: Record<string, { address: Address }>;
};
const chainEnv: Record<string, string> = {};
loadDotenv({ path: resolve(REPO, "zk-contracts/.env"), processEnv: chainEnv, quiet: true });
const apiEnv: Record<string, string> = {};
loadDotenv({ path: resolve(REPO, "zk-api/.env.testnet"), processEnv: apiEnv, quiet: true });

const API = `http://127.0.0.1:${apiEnv.API_PORT}`;
const CONFIRMATIONS = 2;
const ASSET_ID = BigInt(deployment.parameters.assetId);
const X = deployment.parameters.deployer;
const Y_EXPECTED = deployment.parameters.platform;
const ID_FACTORY: Address = "0xC78D98Dc51434eE834686D5571F11D88F88F1a79";
const CLAIM_ISSUER = deployment.external.claimIssuer;
const REGISTRY = deployment.contracts.credentialRegistry!.address;
const ATTESTOR = deployment.contracts.complianceAttestor!.address;
const MODULE = deployment.contracts.zkComplianceModule!.address;
const TOKEN = deployment.contracts.token!.address;
const IR = deployment.contracts.identityRegistry!.address;
const MC = deployment.contracts.modularCompliance!.address;
const LIMITS: Record<string, bigint> = { Y: parseEther("0.005"), X: parseEther("0.002") };
const ADMITTED = [170, 484, 604, 152, 724];
const MINT = parseUnits("1000", 18);
const TRANSFER = parseUnits("250", 18);
const REFUSED = parseUnits("100", 18);
const KYC_TOPIC = 1n;

const idFactoryAbi = parseAbi([
  "function getIdentity(address wallet) view returns (address)",
  "function createIdentityWithManagementKeys(address wallet, string salt, bytes32[] managementKeys) returns (address)",
]);
const identityAbi = parseAbi([
  "function keyHasPurpose(bytes32 key, uint256 purpose) view returns (bool)",
  "function addKey(bytes32 key, uint256 purpose, uint256 keyType) returns (bool)",
  "function addClaim(uint256 topic, uint256 scheme, address issuer, bytes signature, bytes data, string uri) returns (bytes32)",
  "function getClaimIdsByTopic(uint256 topic) view returns (bytes32[])",
]);
const identityRegistryAbi = parseAbi([
  "function registerIdentity(address userAddress, address identity, uint16 country)",
  "function isVerified(address userAddress) view returns (bool)",
  "function contains(address userAddress) view returns (bool)",
  "function investorCountry(address userAddress) view returns (uint16)",
  "function isAgent(address agent) view returns (bool)",
]);
const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function paused() view returns (bool)",
  "function isFrozen(address account) view returns (bool)",
  "function getFrozenTokens(address account) view returns (uint256)",
  "function isAgent(address agent) view returns (bool)",
]);
const complianceAbi = parseAbi([
  "function canTransfer(address from, address to, uint256 amount) view returns (bool)",
  "function getModules() view returns (address[])",
]);
const moduleAbi = parseAbi([
  "function moduleCheck(address from, address to, uint256 value, address compliance) view returns (bool)",
]);
const registryAbi = parseAbi([
  "function credentialRoot() view returns (uint256)",
  "function countryRootOf(uint256 assetId) view returns (uint256)",
  "function isCredentialRootValid(uint256 root) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
const roleAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const role = (name: string) => keccak256(stringToHex(name));
const keyOf = (address: Address) => keccak256(encodeAbiParameters([{ type: "address" }], [address]));

const log = new Log(LOG_PATH);
const transport = http(chainEnv.BASE_SEPOLIA_RPC_URL, { retryCount: 6, retryDelay: 500, timeout: 30_000 });
const client = createPublicClient({ chain: baseSepolia, transport }) as PublicClient;
const platform = privateKeyToAccount(chainEnv.PLATFORM_PRIVATE_KEY as `0x${string}`);
log.secret(chainEnv.PLATFORM_PRIVATE_KEY);
log.secret(chainEnv.BASE_SEPOLIA_RPC_URL);
log.secret(chainEnv.DEPLOYER_PRIVATE_KEY);
log.secret(chainEnv.ETHERSCAN_API_KEY);

const store = Store.open(STATE_PATH, (): E2EState => {
  const fresh = (countryCode: number) => {
    const privateKey = generatePrivateKey();
    return { wallet: { privateKey, address: privateKeyToAccount(privateKey).address }, countryCode };
  };
  return {
    runId: randomBytes(4).toString("hex"),
    startedAt: new Date().toISOString(),
    partners: {},
    investors: { A: fresh(170), B: fresh(484), C: fresh(840) },
    completed: [],
    txs: [],
  };
});
const state = store.state;
for (const investor of Object.values(state.investors)) {
  log.secret(investor.wallet.privateKey);
  log.secret(investor.passphrase);
}
for (const partner of Object.values(state.partners)) log.secret(partner.secret);

const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, chain: baseSepolia, transport });
const platformWallet = wallet(platform);
const account = (name: string) => privateKeyToAccount(state.investors[name]!.wallet.privateKey);
const addressOf = (name: string) => state.investors[name]!.wallet.address;

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, attempts = 20): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return last as T;
}

function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

async function balances(): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {
    X: await client.getBalance({ address: X }),
    Y: await client.getBalance({ address: platform.address }),
  };
  for (const name of Object.keys(state.investors)) out[name] = await client.getBalance({ address: addressOf(name) });
  return out;
}

async function ensureBudget(): Promise<void> {
  const baseline = state.baseline!.balances;
  const now = await balances();
  for (const [name, limit] of Object.entries(LIMITS)) {
    const spent = BigInt(baseline[name]!) - now[name]!;
    if (spent > limit) throw new StopError(`gasto de ${name} ${eth(spent)} supera el límite ${eth(limit)}`);
  }
}

async function track(hash: Hash, label: string, signer: string, via: string): Promise<TxRecord> {
  const existing = state.txs.find((tx) => tx.hash === hash);
  if (existing) return existing;
  const record = await receiptRecord(client, hash, label, signer, via, CONFIRMATIONS);
  state.txs.push(record);
  store.save();
  log.line(`tx ${label} · firma ${signer} (${via}) · ${record.status} · bloque ${record.block} · gas ${record.gasUsed} · coste ${eth(record.feeWei)} · ${basescanTx(hash)}`);
  return record;
}

async function sendAsPlatform(label: string, call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) {
  await ensureBudget();
  const { request } = await client.simulateContract({ account: platform, ...call } as never);
  const hash = await platformWallet.writeContract(request as never);
  const record = await track(hash, label, "Y", "orquestador");
  check(record.status === "success", `${label} revirtió en cadena`);
  return record;
}

const clients: Record<string, PartnerClient> = {};
const actors: Record<string, string> = {
  platform: "e2e:mesa-de-emision",
  bank: "e2e:analista-banco",
  compliance: "e2e:oficial-cumplimiento",
  audit: "e2e:auditor",
  operator: "e2e:operador",
};
function partner(name: string): PartnerClient {
  const record = state.partners[name];
  check(record, `socio ${name} sin registrar`);
  clients[name] ??= new PartnerClient(API, { partnerKey: record.partnerKey, secret: record.secret }, actors[name]);
  return clients[name];
}

function brief(body: unknown): unknown {
  if (body && typeof body === "object" && "opening" in body) {
    const { opening, ...rest } = body as { opening: { pathElements: string[] } };
    return { ...rest, opening: `[${opening.pathElements.length} niveles]` };
  }
  if (body && typeof body === "object" && "activation" in body) {
    const { activation, ...rest } = body as { activation: unknown };
    return { ...rest, activation: "[mensajes EIP-712 para la billetera]" };
  }
  return body;
}

async function call<T = Record<string, unknown>>(
  who: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  logBody = true,
): Promise<ApiResponse<T>> {
  log.line(`→ ${method} ${path} · socio ${who} (${state.partners[who]?.partnerKey})${body !== undefined && logBody ? ` · ${JSON.stringify(body)}` : ""}`);
  const response = await partner(who).request<T>(method, path, body);
  log.json(`← ${response.status}`, brief(response.body));
  return response;
}

async function rebuildAfterFailure(context: string): Promise<never> {
  log.line(`error de la API en ${context}: se reconcilia el estado antes de seguir`);
  await call("operator", "POST", "/v1/issuer/state/rebuild");
  await call("operator", "POST", `/v1/issuer/assets/${ASSET_ID}/state/rebuild`);
  throw new StopError(`${context} falló; estado reconciliado y guardado para retomar`);
}

// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  log.step("0 · Comprobaciones previas (solo lectura)");
  const chainId = await client.getChainId();
  check(chainId === 84532, `la red es ${chainId}, no Base Sepolia`);
  check(platform.address === Y_EXPECTED, "la clave de la plataforma no es Y");
  const health = await fetch(`${API}/health`).then((r) => r.json());
  log.json("zk-api /health", health);

  const facts = {
    "registry.ISSUER_ROLE(Y)": await read<boolean>(REGISTRY, registryAbi, "hasRole", [role("ISSUER_ROLE"), platform.address]),
    "registry.JURISDICTION_ROLE(Y)": await read<boolean>(REGISTRY, registryAbi, "hasRole", [role("JURISDICTION_ROLE"), platform.address]),
    "attestor.ATTESTATION_MANAGER_ROLE(Y)": await read<boolean>(ATTESTOR, roleAbi, "hasRole", [role("ATTESTATION_MANAGER_ROLE"), platform.address]),
    "IR.isAgent(Y)": await read<boolean>(IR, identityRegistryAbi, "isAgent", [platform.address]),
    "token.isAgent(Y)": await read<boolean>(TOKEN, tokenAbi, "isAgent", [platform.address]),
    "IdFactory.owner == Y": (await read<Address>(ID_FACTORY, parseAbi(["function owner() view returns (address)"]), "owner")) === platform.address,
    "ClaimIssuer: Y con propósito CLAIM (3)": await read<boolean>(CLAIM_ISSUER, identityAbi, "keyHasPurpose", [keyOf(platform.address), 3n]),
    "MC.getModules == [módulo ZK]": JSON.stringify(await read<Address[]>(MC, complianceAbi, "getModules")) === JSON.stringify([MODULE]),
  };
  log.json("hechos", facts);
  for (const [fact, value] of Object.entries(facts)) check(value === true, fact);

  if (!state.baseline) {
    const now = await balances();
    state.baseline = {
      block: (await client.getBlockNumber()).toString(),
      balances: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.toString()])),
    };
    store.save();
  }
  log.json("saldos de partida", Object.fromEntries(Object.entries(state.baseline.balances).map(([k, v]) => [k, eth(v)])));
  log.line(`precio del gas ${await client.getGasPrice()} wei · bloque ${await client.getBlockNumber()}`);
  for (const [name, investor] of Object.entries(state.investors)) {
    log.line(`inversor ${name}: ${investor.wallet.address} (EOA nueva, país ${investor.countryCode})`);
  }
}

const PARTNERS: Record<string, string[]> = {
  platform: ["credentials:issue", "credentials:activate", "credentials:revoke", "credentials:read", "credentials:opening", "jurisdictions:write"],
  bank: ["proofs:verify", "proofs:read", "compliance:read", "disclosures:request", "disclosures:read", "disclosures:approve"],
  compliance: ["disclosures:approve", "disclosures:read"],
  audit: ["audit:read"],
  operator: ["issuer:admin"],
};

async function registerPartners(): Promise<void> {
  log.step("1 · Socios con alcances separados (operador, npm run partner:create)");
  for (const [name, scopes] of Object.entries(PARTNERS)) {
    if (!state.partners[name]) {
      const output = execFileSync("npx", ["tsx", "scripts/create-partner.ts", `e2e-${state.runId}-${name}`, ...scopes], {
        cwd: resolve(REPO, "zk-api"),
        env: { ...process.env, DOTENV_CONFIG_PATH: ".env.testnet" },
        encoding: "utf8",
      });
      const created = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as PartnerRecord;
      log.secret(created.secret);
      state.partners[name] = created;
      store.save();
    }
    const record = state.partners[name]!;
    log.line(`socio ${name}: ${record.partnerKey} · ${record.name} · alcances ${record.scopes.join(" ")}`);
  }
  log.line("nota: el banco lleva también disclosures:approve a propósito, para que la separación de partes la imponga el código y no el reparto de alcances");
}

async function provisionInvestor(name: string): Promise<void> {
  const investor = state.investors[name]!;
  const holder = investor.wallet.address;
  log.line(`— inversor ${name} (${holder})`);

  if (!investor.identity) {
    let identity = await read<Address>(ID_FACTORY, idFactoryAbi, "getIdentity", [holder]);
    if (identity === zeroAddress) {
      await sendAsPlatform(`identidad ${name} · IdFactory.createIdentityWithManagementKeys`, {
        address: ID_FACTORY,
        abi: idFactoryAbi,
        functionName: "createIdentityWithManagementKeys",
        args: [holder, `investor-${holder.toLowerCase()}`, [keyOf(platform.address)]],
      });
      identity = await eventually(() => read<Address>(ID_FACTORY, idFactoryAbi, "getIdentity", [holder]), (v) => v !== zeroAddress);
    }
    check(identity !== zeroAddress, `la identidad de ${name} no aparece`);
    investor.identity = identity;
    store.save();
  }
  const identity = investor.identity!;
  log.line(`ONCHAINID de ${name}: ${identity}`);

  const claims = await read<Hash[]>(identity, identityAbi, "getClaimIdsByTopic", [KYC_TOPIC]);
  if (claims.length === 0) {
    const issuerKey = keyOf(CLAIM_ISSUER);
    if (!(await read<boolean>(identity, identityAbi, "keyHasPurpose", [issuerKey, 3n]))) {
      await sendAsPlatform(`identidad ${name} · addKey(ClaimIssuer, CLAIM)`, {
        address: identity,
        abi: identityAbi,
        functionName: "addKey",
        args: [issuerKey, 3n, 1n],
      });
    }
    const data = stringToHex("kyc-approved");
    const digest = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [identity, KYC_TOPIC, data]),
    );
    const signature = await platform.signMessage({ message: { raw: digest } });
    await sendAsPlatform(`identidad ${name} · addClaim(tópico 1, firmado por Y)`, {
      address: identity,
      abi: identityAbi,
      functionName: "addClaim",
      args: [KYC_TOPIC, 1n, CLAIM_ISSUER, signature, data, ""],
    });
  }

  if (!(await read<boolean>(IR, identityRegistryAbi, "contains", [holder]))) {
    await sendAsPlatform(`IR del activo ZK · registerIdentity(${name}, país ${investor.countryCode})`, {
      address: IR,
      abi: identityRegistryAbi,
      functionName: "registerIdentity",
      args: [holder, identity, investor.countryCode],
    });
  }
  const verified = await eventually(() => read<boolean>(IR, identityRegistryAbi, "isVerified", [holder]), (v) => v);
  log.line(`IR.isVerified(${name}) = ${verified} · país en el IR ${await read<number>(IR, identityRegistryAbi, "investorCountry", [holder])}`);
  check(verified, `${name} no queda verificado en el IR`);
  investor.registered = true;
  store.save();
}

async function provisionInvestors(names: string[], title: string): Promise<void> {
  log.step(title);
  for (const name of names) await provisionInvestor(name);
}

async function setJurisdictions(): Promise<void> {
  log.step(`3 · Jurisdicciones admitidas del activo ${ASSET_ID}`);
  if (!state.jurisdictions) {
    const response = await call<{ admitted: number[]; countryRoot: string; txHash: Hash }>(
      "platform",
      "PUT",
      `/v1/assets/${ASSET_ID}/jurisdictions`,
      { admitted: ADMITTED },
    );
    if (response.status !== 200) await rebuildAfterFailure("PUT jurisdicciones");
    state.jurisdictions = response.body;
    store.save();
  }
  await track(state.jurisdictions.txHash, "registro · publishCountryRoot (conjunto admitido)", "Y", "zk-api");
  const onChain = await eventually(() => read<bigint>(REGISTRY, registryAbi, "countryRootOf", [ASSET_ID]), (v) => v !== 0n);
  log.line(`countryRootOf(${ASSET_ID}) en cadena = ${onChain} · coincide con la API: ${onChain.toString() === state.jurisdictions.countryRoot}`);
  check(onChain.toString() === state.jurisdictions.countryRoot, "la raíz de jurisdicciones no coincide");
}

function fictitiousIdentity(name: string, countryCode: number) {
  return {
    legalName: `PRUEBA E2E - Inversor ${name} (persona ficticia)`,
    documentType: "TEST-ID",
    documentNumber: `E2E-TEST-${name}-0001`,
    countryCode,
    dateOfBirth: "1990-01-01",
    residenceAddress: `Calle de Prueba ${name.charCodeAt(0) - 64}, ciudad ficticia`,
    kycProvider: "proveedor-ficticio-e2e",
    kycReference: `e2e-kyc-${state.runId}-${name}`,
  };
}

async function issueCredential(name: string): Promise<void> {
  const investor = state.investors[name]!;
  const deploymentDomain = { chainId: 84532, credentialRegistry: REGISTRY };
  log.line(`— credencial de ${name}`);

  if (!investor.credentialId) {
    const expiresAt = new Date(Math.floor(Date.now() / 1000 + 120 * 86_400) * 1000).toISOString();
    investor.kycSubjectId = `e2e-testnet-${state.runId}-${name}`;
    const response = await call<{ credentialId: string; expiresAt: string; activation: { possession: { domain: never } } }>(
      "platform",
      "POST",
      "/v1/credentials",
      {
        kycSubjectId: investor.kycSubjectId,
        holderAddress: investor.wallet.address,
        verification: { approved: true, countryCode: investor.countryCode, expiresAt, reference: `e2e-verif-${state.runId}-${name}` },
        identity: fictitiousIdentity(name, investor.countryCode),
      },
    );
    check(response.status === 201, `POST /v1/credentials de ${name} respondió ${response.status}`);
    check(sameDomain(response.body.activation.possession.domain, holderDomain(deploymentDomain)), "el dominio EIP-712 del emisor no es el del cliente");
    log.line("el dominio EIP-712 que entrega la API coincide con el que el cliente reimplementa");
    investor.credentialId = response.body.credentialId;
    investor.expiresAt = response.body.expiresAt;
    store.save();
  }

  if (!investor.backup) {
    const secret = generateHolderSecret();
    const passphrase = randomBytes(18).toString("base64url");
    log.secret(secret);
    log.secret(passphrase);
    investor.backup = sealHolderSecret(secret, passphrase);
    investor.passphrase = passphrase;
    store.save();
    log.line(`titular ${name}: secreto generado en local (muestreo uniforme en el campo) y sellado en una copia scrypt + AES-256-GCM`);
  }
  const secret = openHolderSecret(investor.backup as HolderSecretBackup, investor.passphrase!);
  log.secret(secret);
  const secretHash = await holderSecretHash(secret);
  investor.secretHash = secretHash.toString();
  const expected = await credentialCommitment(secretHash, investor.countryCode, expiryOf(investor.expiresAt!));
  log.line(`titular ${name}: copia de seguridad abierta de nuevo con su frase · secretHash = ${secretHash} · compromiso esperado ${expected}`);

  if (!investor.activated) {
    const existing = await call<{ status: string }>("platform", "GET", `/v1/credentials/${expected}`);
    if (existing.status === 200 && existing.body.status === "ACTIVE") {
      log.line(`la credencial de ${name} ya estaba activa (se retoma)`);
    } else {
      const signature = await signActivation(account(name), deploymentDomain, investor.credentialId!, secretHash);
      const signer = await recoverActivationSigner(deploymentDomain, investor.credentialId!, secretHash, signature);
      log.line(`titular ${name}: firma de posesión EIP-712 CredentialActivation (sin transacción) · se recupera a ${signer}`);
      check(signer === investor.wallet.address, "la firma de posesión no se recupera al titular");
      const response = await call<{ commitment: string; txHash: Hash; credentialRoot: string; leafIndex: number }>(
        "platform",
        "POST",
        `/v1/credentials/${investor.credentialId}/activation`,
        { secretHash: secretHash.toString(), signature },
      );
      if (response.status !== 201) await rebuildAfterFailure(`activación de ${name}`);
      check(response.body.commitment === expected.toString(), "el compromiso publicado no es el que calcula el titular");
      log.line(`el compromiso que publicó el emisor coincide con el que calculó el titular: ${response.body.commitment}`);
      await track(response.body.txHash, `registro · publishCredentialRoot (activación ${name})`, "Y", "zk-api");
    }
    investor.commitment = expected.toString();
    investor.activated = true;
    store.save();
  }
}

async function issueCredentials(names: string[], title: string): Promise<void> {
  log.step(title);
  for (const name of names) await issueCredential(name);
}

async function proofFor(name: string): Promise<void> {
  const investor = state.investors[name]!;
  const subject = investor.wallet.address;
  log.line(`— prueba de ${name}`);
  const secret = openHolderSecret(investor.backup as HolderSecretBackup, investor.passphrase!);

  const credential = await call<CredentialOpeningResponse>("platform", "GET", `/v1/credentials/${investor.commitment}/opening`);
  check(credential.status === 200, "sin apertura de la credencial");
  const jurisdiction = await call<JurisdictionOpeningResponse>(
    "platform",
    "GET",
    `/v1/assets/${ASSET_ID}/jurisdictions/${investor.countryCode}/opening`,
  );
  check(jurisdiction.status === 200, "sin apertura de la jurisdicción");
  const context = await readProvingContext(client, ATTESTOR, subject);
  log.json(`contexto en cadena (bloque ${context.blockNumber})`, {
    currentEpochEnd: context.currentEpochEnd,
    epochLength: context.epochLength,
    epochEndReclamado: context.epochEnd,
    anchorFor: context.anchor,
  });

  const witness = await buildWitness({
    secret,
    countryCode: investor.countryCode,
    expiry: expiryOf(investor.expiresAt!),
    assetId: ASSET_ID,
    epochEnd: context.epochEnd,
    anchor: context.anchor,
    credential: credential.body,
    jurisdiction: jurisdiction.body,
  });
  const started = Date.now();
  const proof = await proveCompliance(witness.input, ARTIFACTS);
  const locally = await verifyLocally(proof, ARTIFACTS.verificationKeyPath);
  log.line(`prueba Groth16 generada en local en ${Date.now() - started} ms · verifica contra groth16.vkey.json: ${locally}`);
  check(locally, "la prueba no verifica en local");
  log.json("señales públicas", Object.fromEntries(["credentialRoot", "countryRoot", "assetId", "epochEnd", "nullifier", "anchor"].map((k, i) => [k, proof.publicSignals[i]])));

  const verification = await call<{ id: string; valid: boolean; rejectionCode: string | null }>(
    "bank",
    "POST",
    "/v1/verifications",
    { proof: proof.callData },
    false,
  );
  check(verification.status === 201 && verification.body.valid, `el banco no valida la prueba de ${name}`);

  investor.callData = proof.callData;
  investor.nullifier = witness.nullifier.toString();
  investor.epochEnd = context.epochEnd.toString();
  investor.verificationId = verification.body.id;
  store.save();
}

async function attest(name: string): Promise<void> {
  const investor = state.investors[name]!;
  const subject = investor.wallet.address;
  const before = { nonce: await client.getTransactionCount({ address: subject }), balance: await client.getBalance({ address: subject }) };
  log.line(`${name} antes de atestiguar: nonce ${before.nonce} · saldo ${eth(before.balance)}`);
  check(before.nonce === 0 && before.balance === 0n, `${name} ya tenía actividad propia`);

  await ensureBudget();
  const args = attestorArguments(investor.callData as Groth16CallData);
  const outcome = await presentForSubject({
    publicClient: client,
    walletClient: platformWallet,
    attestor: ATTESTOR,
    subject,
    proof: args.proof,
    signals: args.signals,
    confirmations: CONFIRMATIONS,
  });
  if (outcome.status === "attested") {
    const record = await track(outcome.txHash, `atestador · attestFor(${name})`, "Y", "orquestador (plataforma)");
    const [event] = parseEventLogs({ abi: complianceAttestorAbi, logs: outcome.receipt.logs, eventName: "ComplianceAttested" });
    log.line(`ComplianceAttested: sujeto ${event?.args.subject} · nulificador ${event?.args.nullifier} · caduca ${event?.args.expiresAt} · remitente de la transacción ${record.from}`);
    check(event?.args.subject === subject && record.from.toLowerCase() === platform.address.toLowerCase(), "el evento no nombra al titular o no lo envió Y");
  } else {
    log.json(`presentación de ${name} resuelta sin transacción nueva`, outcome);
  }

  const attestation = await read<{ expiresAt: bigint; nullifier: bigint }>(ATTESTOR, complianceAttestorAbi, "attestationOf", [ASSET_ID, subject]);
  check(attestation.nullifier.toString() === investor.nullifier, "la atestación no lleva el nulificador de la prueba");
  const after = { nonce: await client.getTransactionCount({ address: subject }), balance: await client.getBalance({ address: subject }) };
  log.line(`${name} después de atestiguar: nonce ${after.nonce} · saldo ${eth(after.balance)} · ${name} no envió ninguna transacción ni pagó gas`);
  check(after.nonce === 0 && after.balance === 0n, `${name} envió algo`);
  investor.attested = true;
  store.save();
}

async function compliance(name: string): Promise<{ compliant: boolean }> {
  const response = await call<{ compliant: boolean }>("bank", "GET", `/v1/compliance/assets/${ASSET_ID}/subjects/${addressOf(name)}`);
  check(response.status === 200, "consulta de cumplimiento fallida");
  const text = JSON.stringify(response.body);
  check(!/legalName|documentNumber|dateOfBirth|countryCode/.test(text), "la respuesta de cumplimiento lleva datos personales");
  return response.body;
}

async function mintAndTransfer(): Promise<void> {
  log.step("8 · Y acuña a A como agente; A transfiere a B");
  const A = addressOf("A");
  const B = addressOf("B");
  if (!state.minted) {
    await sendAsPlatform("token · mint(A, 1000 ZKCTA) por Y (agente)", { address: TOKEN, abi: tokenAbi, functionName: "mint", args: [A, MINT] });
    state.minted = true;
    store.save();
  }
  log.line(`saldo de A: ${await read<bigint>(TOKEN, tokenAbi, "balanceOf", [A])} (unidades con 18 decimales)`);

  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas * 2n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  const gas = ((await client.estimateContractGas({ account: A, address: TOKEN, abi: tokenAbi, functionName: "transfer", args: [B, TRANSFER] })) * 13n) / 10n;
  if (!state.funded) {
    const mintL1 = BigInt(state.txs.find((tx) => tx.label.startsWith("token · mint"))?.l1Fee ?? "0");
    const l1Cushion = mintL1 * 10n > 10_000_000_000n ? mintL1 * 10n : 10_000_000_000n;
    const value = 2n * gas * maxFeePerGas + 2n * l1Cushion;
    log.line(`fondeo mínimo de A para dos transferencias: 2 × (${gas} gas × ${maxFeePerGas} wei) + 2 × ${l1Cushion} wei de tarifa L1 = ${eth(value)}`);
    await ensureBudget();
    const hash = await platformWallet.sendTransaction({ to: A, value });
    const record = await track(hash, "fondeo · Y → A (ETH para el gas de A)", "Y", "orquestador");
    check(record.status === "success", "el fondeo falló");
    state.funded = true;
    store.save();
  }
  state.transferGas = gas.toString();
  store.save();

  if (!state.transferred) {
    const hash = await wallet(account("A")).writeContract({
      address: TOKEN,
      abi: tokenAbi,
      functionName: "transfer",
      args: [B, TRANSFER],
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const record = await track(hash, "token · transfer(A → B, 250 ZKCTA)", "A", "billetera de A");
    check(record.status === "success", "la transferencia de A a B revirtió");
    state.transferred = true;
    store.save();
  }
  log.line(`saldos tras la transferencia: A ${await read<bigint>(TOKEN, tokenAbi, "balanceOf", [A])} · B ${await read<bigint>(TOKEN, tokenAbi, "balanceOf", [B])}`);
}

async function revokeB(): Promise<void> {
  log.step("9 · Revocación de la credencial de B (API) y de su atestación (Y)");
  const B = state.investors.B!;
  if (!state.revocation) {
    const response = await call<{ txHash: Hash; previousRoot: string; previousRootInvalidated: boolean; credentialRoot: string }>(
      "platform",
      "POST",
      `/v1/credentials/${B.commitment}/revocation`,
      { closeRootWindow: true },
    );
    if (response.status !== 200) await rebuildAfterFailure("revocación de B");
    state.revocation = response.body;
    store.save();
  }
  const revocation = state.revocation as { txHash: Hash; previousRoot: string; previousRootInvalidated: boolean };
  const published = await track(revocation.txHash, "registro · publishCredentialRoot (revocación de B, hoja retirada)", "Y", "zk-api");
  if (revocation.previousRootInvalidated) {
    const logs = await client.getLogs({
      address: REGISTRY,
      event: parseAbiItem("event CredentialRootInvalidated(uint256 indexed root)"),
      args: { root: BigInt(revocation.previousRoot) },
      fromBlock: BigInt(published.block),
      toBlock: "latest",
    });
    const invalidation = logs[0]?.transactionHash;
    check(invalidation, "no se encuentra la invalidación de la raíz anterior");
    await track(invalidation, "registro · invalidateCredentialRoot (cierra la ventana de la raíz anterior)", "Y", "zk-api");
  }
  log.line(`raíz anterior ${revocation.previousRoot} sigue válida: ${await read<boolean>(REGISTRY, registryAbi, "isCredentialRootValid", [BigInt(revocation.previousRoot)])}`);

  const current = await read<{ expiresAt: bigint }>(ATTESTOR, complianceAttestorAbi, "attestationOf", [ASSET_ID, B.wallet.address]);
  if (current.expiresAt !== 0n && !state.attestationRevoked) {
    await sendAsPlatform("atestador · revokeAttestation(84532001, B)", {
      address: ATTESTOR,
      abi: complianceAttestorAbi,
      functionName: "revokeAttestation",
      args: [ASSET_ID, B.wallet.address],
    });
  }
  state.attestationRevoked = true;
  B.revoked = true;
  store.save();

  const standing = await call<{ status: string; inRegistry: boolean }>("platform", "GET", `/v1/credentials/${B.commitment}`);
  check(standing.body.status === "REVOKED" && !standing.body.inRegistry, "la credencial de B no figura revocada");
  const stateB = await compliance("B");
  check(!stateB.compliant, "B sigue conforme");
  const stateA = await compliance("A");
  check(stateA.compliant, "A dejó de ser conforme");
  log.line("B ya no es conforme; A sigue siéndolo");

  log.line("— una transferencia de A a B se rechaza, y el rechazo es del módulo ZK");
  const A = addressOf("A");
  const to = B.wallet.address;
  const facts = {
    "IR.isVerified(B)": await read<boolean>(IR, identityRegistryAbi, "isVerified", [to]),
    "IR.isVerified(A)": await read<boolean>(IR, identityRegistryAbi, "isVerified", [A]),
    "token.paused()": await read<boolean>(TOKEN, tokenAbi, "paused"),
    "token.isFrozen(A)": await read<boolean>(TOKEN, tokenAbi, "isFrozen", [A]),
    "token.isFrozen(B)": await read<boolean>(TOKEN, tokenAbi, "isFrozen", [to]),
    "token.getFrozenTokens(A)": await read<bigint>(TOKEN, tokenAbi, "getFrozenTokens", [A]),
    "saldo de A >= importe": (await read<bigint>(TOKEN, tokenAbi, "balanceOf", [A])) >= REFUSED,
    "MC.getModules()": await read<Address[]>(MC, complianceAbi, "getModules"),
    "attestor.isAttested(B)": await read<boolean>(ATTESTOR, complianceAttestorAbi, "isAttested", [ASSET_ID, to]),
    "module.moduleCheck(A, B)": await read<boolean>(MODULE, moduleAbi, "moduleCheck", [A, to, REFUSED, MC]),
    "MC.canTransfer(A, B)": await read<boolean>(MC, complianceAbi, "canTransfer", [A, to, REFUSED]),
  };
  log.json("atribución", facts);
  check(facts["IR.isVerified(B)"] && facts["IR.isVerified(A)"] && !facts["token.paused()"], "otra regla del estándar bloquearía");
  check(!facts["token.isFrozen(A)"] && !facts["token.isFrozen(B)"] && facts["token.getFrozenTokens(A)"] === 0n, "hay congelamientos");
  check(facts["saldo de A >= importe"], "A no tiene saldo");
  check(JSON.stringify(facts["MC.getModules()"]) === JSON.stringify([MODULE]), "hay otros módulos");
  check(!facts["module.moduleCheck(A, B)"] && !facts["MC.canTransfer(A, B)"], "el módulo ZK no deniega");

  try {
    await client.simulateContract({ account: A, address: TOKEN, abi: tokenAbi, functionName: "transfer", args: [to, REFUSED] });
    throw new StopError("la simulación de la transferencia a B no revirtió");
  } catch (error) {
    if (error instanceof StopError) throw error;
    log.line(`simulación de transfer(A → B, 100 ZKCTA): revierte con "${revertName(error)?.name ?? (error as Error).message.split("\n")[0]}"`);
  }

  if (!state.refusedTransfer) {
    const fees = await client.estimateFeesPerGas();
    const gas = BigInt(state.transferGas ?? "150000");
    const hash = await wallet(account("A")).writeContract({
      address: TOKEN,
      abi: tokenAbi,
      functionName: "transfer",
      args: [to, REFUSED],
      gas,
      maxFeePerGas: fees.maxFeePerGas * 2n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const record = await track(hash, "token · transfer(A → B, 100 ZKCTA) rechazada", "A", "billetera de A");
    check(record.status === "reverted", "la transferencia a B no revirtió en cadena");
    state.refusedTransfer = true;
    store.save();
  }
  log.line(`saldos sin cambios: A ${await read<bigint>(TOKEN, tokenAbi, "balanceOf", [A])} · B ${await read<bigint>(TOKEN, tokenAbi, "balanceOf", [to])}`);

  log.line("— vigencia de las verificaciones que el banco hizo antes de presentar");
  for (const name of ["A", "B"]) {
    const response = await call<Record<string, unknown>>("bank", "GET", `/v1/verifications/${state.investors[name]!.verificationId}`);
    check(response.status === 200, "consulta de verificación fallida");
    check(!/legalName|documentNumber|dateOfBirth|residenceAddress|holderAddress/.test(JSON.stringify(response.body)), "la vigencia lleva datos personales");
  }
}

async function disclosure(): Promise<void> {
  log.step("10 · Divulgación autorizada con separación de partes");
  const target = state.investors.B!.commitment!;
  const d = (state.disclosure ??= {}) as Record<string, unknown>;
  const scope = ["identity.legalName", "identity.countryCode"];
  if (!d.id) {
    const response = await call<{ id: string; status: string }>("bank", "POST", "/v1/disclosures", {
      targetCommitment: target,
      requesterRef: `banco-prueba/caso-e2e-${state.runId}`,
      justification: "Prueba de punta a punta: revisión de una credencial revocada en la red de pruebas.",
      legalBasis: "Ejercicio de prueba sin efectos jurídicos (datos ficticios)",
      scope,
    });
    check(response.status === 201, "la solicitud no se creó");
    d.id = response.body.id;
    store.save();
  }
  const id = d.id as string;

  const self = await call<{ code: string }>("bank", "POST", `/v1/disclosures/${id}/decision`, { decision: "APPROVED", decidedBy: "el propio banco" });
  if (self.status !== 403 && !d.approved) throw new StopError(`el banco pudo decidir su propia solicitud: ${self.status}`);
  if (!d.approved) check(self.body.code === "disclosure_self_decision", "código inesperado en la autoaprobación");

  if (!d.approved) {
    const approval = await call<{ status: string; decidedByPartnerKey: string }>("compliance", "POST", `/v1/disclosures/${id}/decision`, {
      decision: "APPROVED",
      decidedBy: "Oficial de cumplimiento (prueba)",
      note: "Aprobada para la prueba de punta a punta",
    });
    check(approval.status === 200 && approval.body.status === "APPROVED", "cumplimiento no pudo aprobar");
    check(approval.body.decidedByPartnerKey === state.partners.compliance!.partnerKey, "el decisor registrado no es cumplimiento");
    d.approved = true;
    store.save();
  }

  const foreign = await call<{ code: string }>("compliance", "POST", `/v1/disclosures/${id}/release`);
  check(foreign.status === 403 && foreign.body.code === "disclosure_not_requester", "cumplimiento pudo liberar");

  if (!d.released) {
    const release = await call<{ scope: string[]; released: Record<string, unknown> }>("bank", "POST", `/v1/disclosures/${id}/release`);
    check(release.status === 200, "el banco no pudo liberar");
    const keys = Object.keys(release.body.released).sort();
    log.line(`atributos liberados: ${keys.join(", ")} · alcance aprobado: ${release.body.scope.join(", ")}`);
    check(JSON.stringify(keys) === JSON.stringify(["countryCode", "legalName"]), "se liberó algo fuera del alcance aprobado");
    d.released = true;
    store.save();
  }
  const again = await call<{ code: string }>("bank", "POST", `/v1/disclosures/${id}/release`);
  check(again.status === 403, "una segunda liberación no se rechazó");
  await call("bank", "GET", `/v1/disclosures/${id}`);
}

async function reconcile(title: string): Promise<void> {
  log.step(title);
  const credentials = await call<{ matchesChain: boolean; missingFromDatabase: string[]; missingFromChain: string[] }>(
    "operator",
    "POST",
    "/v1/issuer/state/rebuild",
  );
  if (credentials.status !== 200) throw new StopError(`la reconstrucción de credenciales respondió ${credentials.status}`);
  check(credentials.body.matchesChain, "el árbol de credenciales no coincide con la cadena");
  const asset = await call<{ matchesChain: boolean }>("operator", "POST", `/v1/issuer/assets/${ASSET_ID}/state/rebuild`);
  if (asset.status !== 200) throw new StopError(`la reconstrucción del activo respondió ${asset.status}`);
  check(asset.body.matchesChain, "el árbol de jurisdicciones no coincide con la cadena");
  const integrity = await call<{ intact: boolean }>("audit", "GET", "/v1/access-log/integrity");
  check(integrity.status === 200 && integrity.body.intact, "el registro de accesos no está íntegro");
  const entries = await call<{ entries?: unknown[] }>("audit", "GET", "/v1/access-log?limit=5");
  check(entries.status === 200, "no se pudo leer el registro de accesos");
  const denied = await call<{ code: string }>("bank", "GET", "/v1/access-log/integrity");
  check(denied.status === 403 && denied.body.code === "insufficient_scope", "el banco pudo leer la auditoría");
}

async function outsider(): Promise<void> {
  log.step("12 · C, con un país no admitido (840), no puede obtener una prueba válida");
  const C = state.investors.C!;
  const subject = C.wallet.address;
  const secret = openHolderSecret(C.backup as HolderSecretBackup, C.passphrase!);
  log.secret(secret);

  const own = await call<{ code: string }>("platform", "GET", `/v1/assets/${ASSET_ID}/jurisdictions/840/opening`);
  check(own.status === 404 && own.body.code === "jurisdiction_not_admitted", "la API entregó una apertura para 840");

  const credential = await call<CredentialOpeningResponse>("platform", "GET", `/v1/credentials/${C.commitment}/opening`);
  check(credential.status === 200, "sin apertura de la credencial de C");
  const colombia = await call<JurisdictionOpeningResponse>("platform", "GET", `/v1/assets/${ASSET_ID}/jurisdictions/170/opening`);
  const context = await readProvingContext(client, ATTESTOR, subject);
  const base = {
    secret,
    expiry: expiryOf(C.expiresAt!),
    assetId: ASSET_ID,
    epochEnd: context.epochEnd,
    anchor: context.anchor,
    credential: credential.body,
    jurisdiction: colombia.body,
  };

  try {
    await buildWitness({ ...base, countryCode: 840 });
    throw new StopError("el cliente aceptó una apertura de otro país");
  } catch (error) {
    if (!(error instanceof WitnessError)) throw error;
    log.line(`intento 1 · país real 840 con la única apertura que existe (la de 170): el cliente lo rechaza antes de probar (${error.code})`);
  }
  for (const [label, countryCode] of [
    ["intento 2 · país real 840 con la apertura de 170, sin las comprobaciones del cliente", 840],
    ["intento 3 · declarar 170 en vez de 840", 170],
  ] as const) {
    const witness = await buildWitness({ ...base, countryCode }, { check: false });
    try {
      await proveCompliance(witness.input, ARTIFACTS);
      throw new StopError(`${label}: el circuito produjo una prueba`);
    } catch (error) {
      if (error instanceof StopError) throw error;
      log.line(`${label}: el circuito no tiene testigo → ${(error as Error).message.split("\n")[0]}`);
    }
  }
  log.line("intento 2 falla en la pertenencia de la jurisdicción (la hoja 840 no está en el árbol del activo); intento 3 falla en la pertenencia de la credencial (el compromiso publicado fija 840)");

  const standard = await read<boolean>(IR, identityRegistryAbi, "isVerified", [subject]);
  const canReceive = await read<boolean>(MC, complianceAbi, "canTransfer", [zeroAddress, subject, MINT]);
  log.line(`C está verificado por el estándar (IR.isVerified = ${standard}) y aun así MC.canTransfer(0, C) = ${canReceive}`);
  check(standard && !canReceive, "C podría recibir");
  try {
    await client.simulateContract({ account: platform, address: TOKEN, abi: tokenAbi, functionName: "mint", args: [subject, MINT] });
    throw new StopError("la simulación del mint a C no revirtió");
  } catch (error) {
    if (error instanceof StopError) throw error;
    log.line(`simulación de mint(C) por Y: revierte con "${revertName(error)?.name ?? (error as Error).message.split("\n")[0]}" (no se envía)`);
  }
  const stateC = await call<{ compliant: boolean }>("bank", "GET", `/v1/compliance/assets/${ASSET_ID}/subjects/${subject}`);
  check(!stateC.body.compliant, "C figura conforme");
}

async function refusalReasons(): Promise<void> {
  log.step("Cierre · motivo de los rechazos, leído del contrato (simulación, sin enviar)");
  const attempts: [string, Address, string, readonly unknown[]][] = [
    ["transfer(A → B, 100 ZKCTA) desde A", addressOf("A"), "transfer", [addressOf("B"), REFUSED]],
    ["mint(C, 1000 ZKCTA) por Y", platform.address, "mint", [addressOf("C"), MINT]],
    ["transfer(A → C, 100 ZKCTA) desde A", addressOf("A"), "transfer", [addressOf("C"), REFUSED]],
  ];
  for (const [label, from, functionName, args] of attempts) {
    try {
      await client.simulateContract({ account: from, address: TOKEN, abi: tokenAbi, functionName, args } as never);
      throw new StopError(`${label} no revierte`);
    } catch (error) {
      if (error instanceof StopError) throw error;
      const reason = revertName(error)?.name ?? (error as Error).message.split("\n")[0];
      log.line(`${label}: revierte con "${reason}"`);
      check(reason === "Transfer not possible" || reason === "Compliance not followed", `motivo inesperado: ${reason}`);
    }
  }
  const A = addressOf("A");
  for (const name of ["B", "C"]) {
    const to = addressOf(name);
    log.line(`${name}: isVerified ${await read<boolean>(IR, identityRegistryAbi, "isVerified", [to])} · isAttested ${await read<boolean>(ATTESTOR, complianceAttestorAbi, "isAttested", [ASSET_ID, to])} · moduleCheck(A, ${name}) ${await read<boolean>(MODULE, moduleAbi, "moduleCheck", [A, to, REFUSED, MC])} · canTransfer(A, ${name}) ${await read<boolean>(MC, complianceAbi, "canTransfer", [A, to, REFUSED])}`);
  }
}

async function summary(): Promise<void> {
  log.step("Resumen de gasto");
  const now = await balances();
  const baseline = state.baseline!.balances;
  const perSigner: Record<string, bigint> = {};
  for (const tx of state.txs) perSigner[tx.signer] = (perSigner[tx.signer] ?? 0n) + BigInt(tx.feeWei);
  for (const name of Object.keys(now)) {
    log.line(`${name}: saldo ${eth(baseline[name]!)} → ${eth(now[name]!)} · diferencia ${eth(BigInt(baseline[name]!) - now[name]!)} · comisiones de sus transacciones ${eth(perSigner[name] ?? 0n)}`);
  }
  log.line(`transacciones registradas: ${state.txs.length}`);
  for (const tx of state.txs) {
    log.line(`  ${tx.signer} · ${tx.label} · ${tx.status} · gas ${tx.gasUsed} · ${eth(tx.feeWei)} · ${tx.hash}`);
  }
}

async function main(): Promise<void> {
  log.line();
  log.line(`##### corrida E2E en Base Sepolia · id ${state.runId} · ${state.completed.length > 0 ? `retoma tras: ${state.completed.join(", ")}` : "desde el principio"}`);
  await preflight();
  if (!store.done("partners")) await registerPartners(), store.complete("partners");
  else log.line("1 · socios ya registrados (se retoma)");
  if (!store.done("investors")) await provisionInvestors(["A", "B"], "2 · Inversores A y B: ONCHAINID, claim KYC (tópico 1) e IR del activo ZK"), store.complete("investors");
  if (!store.done("jurisdictions")) await setJurisdictions(), store.complete("jurisdictions");
  if (!store.done("credentials")) await issueCredentials(["A", "B"], "4 · Emisión en dos tiempos de las credenciales de A y B"), store.complete("credentials");
  if (!store.done("proofs")) {
    log.step("5 · El titular prueba en local; el banco comprueba antes de presentar");
    for (const name of ["A", "B"]) if (!state.investors[name]!.attested) await proofFor(name);
    store.complete("proofs");
  }
  if (!store.done("attestations")) {
    log.step("6 · Y presenta con attestFor y paga el gas");
    for (const name of ["A", "B"]) if (!state.investors[name]!.attested) await attest(name);
    store.complete("attestations");
  }
  if (!store.done("compliance")) {
    log.step("7 · Estado de cumplimiento (banco)");
    for (const name of ["A", "B"]) check((await compliance(name)).compliant, `${name} no es conforme`);
    store.complete("compliance");
  }
  if (!store.done("transfer")) await mintAndTransfer(), store.complete("transfer");
  if (!store.done("revocation")) await revokeB(), store.complete("revocation");
  if (!store.done("disclosure")) await disclosure(), store.complete("disclosure");
  if (!store.done("rebuild")) await reconcile("11 · Reconstrucción desde la cadena e integridad del registro de accesos"), store.complete("rebuild");
  if (!store.done("outsider-setup")) {
    await provisionInvestors(["C"], "12a · Inversor C: ONCHAINID, claim KYC e IR con país 840");
    await issueCredentials(["C"], "12b · Credencial de C (país 840, que el activo no admite)");
    store.complete("outsider-setup");
  }
  if (!store.done("outsider")) await outsider(), store.complete("outsider");
  if (!store.done("reasons")) await refusalReasons(), store.complete("reasons");
  if (!store.done("closing")) await reconcile("Cierre · reconciliación final tras el paso de C"), store.complete("closing");
  await summary();
  log.line(`##### corrida ${state.runId} completa`);
}

main()
  .then(async () => {
    await releaseProver();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.line(`DETENIDO: ${error instanceof Error ? error.message.split("\n").slice(0, 6).join(" | ") : String(error)}`);
    log.line(`estado guardado para retomar · pasos completos: ${state.completed.join(", ") || "ninguno"}`);
    await releaseProver();
    process.exit(1);
  });

