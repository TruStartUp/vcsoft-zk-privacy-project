import { contracts as trex, interfaces as trexInterfaces } from "@erc3643org/erc-3643";
import ClaimIssuerArtifact from "@erc3643org/erc-3643/artifacts/@onchain-id/solidity/contracts/ClaimIssuer.sol/ClaimIssuer.json";
import IdentityArtifact from "@erc3643org/erc-3643/artifacts/@onchain-id/solidity/contracts/Identity.sol/Identity.json";
import { ethers } from "hardhat";

/// The real T-REX suite, deployed from the bytecode the ERC-3643 organisation
/// publishes, on the local chain: six implementations behind a
/// TREXImplementationAuthority, and the six proxies the standard defines
/// (claim topics, trusted issuers, identity storage, identity registry,
/// modular compliance and the token itself). Identities and the claim issuer
/// come from ONCHAINID, which is what the identity registry actually calls.
///
/// Nothing here is a stand-in. The confidentiality layer is added to this
/// deployment afterwards, which is the only way to show it is a layer on top
/// of tokenisation and not a replacement for it.

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];
type Artifact = { abi: unknown[]; bytecode: string };

/// The published artifacts carry no TypeChain bindings, so every contract of the
/// standard is reached through its ABI at runtime.
type Contract = any;

const TREX_VERSION = { major: 4, minor: 1, patch: 3 };

const CLAIM_KEY_PURPOSE = 3;
const ECDSA_KEY_TYPE = 1;
const ECDSA_CLAIM_SCHEME = 1;

const TOKEN_NAME = "VCSoft Tokenized Asset";
const TOKEN_SYMBOL = "VCSA";
const TOKEN_DECIMALS = 18;

async function factoryFor(artifact: Artifact, signer: Signer) {
  return ethers.getContractFactory(artifact.abi as never, artifact.bytecode, signer);
}

async function deployFrom(artifact: Artifact, signer: Signer, ...args: unknown[]): Promise<Contract> {
  const factory = await factoryFor(artifact, signer);
  const deployed = await factory.deploy(...args);
  await deployed.waitForDeployment();
  return deployed;
}

async function attachTo(artifact: Artifact, address: string, signer: Signer): Promise<Contract> {
  return (await factoryFor(artifact, signer)).attach(address);
}

export const publishedArtifacts = trex;
export const publishedInterfaces = trexInterfaces;
export const deployPublished = deployFrom;

const keyOf = (address: string) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address"], [address]));

export interface TrexSuite {
  implementationAuthority: Contract;
  claimTopicsRegistry: Contract;
  trustedIssuersRegistry: Contract;
  identityRegistryStorage: Contract;
  identityRegistry: Contract;
  compliance: Contract;
  token: Contract;
  claimIssuer: Contract;
  claimTopic: bigint;
  registerInvestor(investor: Signer, country: number): Promise<Contract>;
}

export interface TrexActors {
  owner: Signer;
  tokenAgent: Signer;
  claimIssuerOwner: Signer;
  claimSigningKey: Signer;
}

export async function deployTrexSuite(actors: TrexActors): Promise<TrexSuite> {
  const { owner, tokenAgent, claimIssuerOwner, claimSigningKey } = actors;
  const claimTopic = BigInt(ethers.id("VCSOFT_KYC_VERIFIED"));

  const tokenImplementation = await deployFrom(trex.Token, owner);
  const ctrImplementation = await deployFrom(trex.ClaimTopicsRegistry, owner);
  const irImplementation = await deployFrom(trex.IdentityRegistry, owner);
  const irsImplementation = await deployFrom(trex.IdentityRegistryStorage, owner);
  const tirImplementation = await deployFrom(trex.TrustedIssuersRegistry, owner);
  const mcImplementation = await deployFrom(trex.ModularCompliance, owner);

  const implementationAuthority = await deployFrom(
    trex.TREXImplementationAuthority,
    owner,
    true,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
  );
  await implementationAuthority.addAndUseTREXVersion(TREX_VERSION, {
    tokenImplementation: await tokenImplementation.getAddress(),
    ctrImplementation: await ctrImplementation.getAddress(),
    irImplementation: await irImplementation.getAddress(),
    irsImplementation: await irsImplementation.getAddress(),
    tirImplementation: await tirImplementation.getAddress(),
    mcImplementation: await mcImplementation.getAddress(),
  });
  const authority = await implementationAuthority.getAddress();

  const claimTopicsRegistry = await attachTo(
    trex.ClaimTopicsRegistry,
    await (await deployFrom(trex.ClaimTopicsRegistryProxy, owner, authority)).getAddress(),
    owner,
  );
  const trustedIssuersRegistry = await attachTo(
    trex.TrustedIssuersRegistry,
    await (await deployFrom(trex.TrustedIssuersRegistryProxy, owner, authority)).getAddress(),
    owner,
  );
  const identityRegistryStorage = await attachTo(
    trex.IdentityRegistryStorage,
    await (await deployFrom(trex.IdentityRegistryStorageProxy, owner, authority)).getAddress(),
    owner,
  );
  const identityRegistry = await attachTo(
    trex.IdentityRegistry,
    await (
      await deployFrom(
        trex.IdentityRegistryProxy,
        owner,
        authority,
        await trustedIssuersRegistry.getAddress(),
        await claimTopicsRegistry.getAddress(),
        await identityRegistryStorage.getAddress(),
      )
    ).getAddress(),
    owner,
  );
  const compliance = await attachTo(
    trex.ModularCompliance,
    await (await deployFrom(trex.ModularComplianceProxy, owner, authority)).getAddress(),
    owner,
  );
  const token = await attachTo(
    trex.Token,
    await (
      await deployFrom(
        trex.TokenProxy,
        owner,
        authority,
        await identityRegistry.getAddress(),
        await compliance.getAddress(),
        TOKEN_NAME,
        TOKEN_SYMBOL,
        TOKEN_DECIMALS,
        ethers.ZeroAddress,
      )
    ).getAddress(),
    owner,
  );

  await identityRegistryStorage.bindIdentityRegistry(await identityRegistry.getAddress());
  await identityRegistry.addAgent(tokenAgent.address);
  await token.addAgent(tokenAgent.address);

  const claimIssuer = await deployFrom(ClaimIssuerArtifact, claimIssuerOwner, claimIssuerOwner.address);
  await claimIssuer
    .connect(claimIssuerOwner)
    .addKey(keyOf(claimSigningKey.address), CLAIM_KEY_PURPOSE, ECDSA_KEY_TYPE);

  await claimTopicsRegistry.addClaimTopic(claimTopic);
  await trustedIssuersRegistry.addTrustedIssuer(await claimIssuer.getAddress(), [claimTopic]);

  await token.connect(tokenAgent).unpause();

  /// An investor as the standard understands one: an ONCHAINID whose management
  /// key is their wallet, carrying a claim signed by the trusted issuer for the
  /// topic the token requires, and registered with their country. This is what
  /// `IdentityRegistry.isVerified` answers to, and it is deliberately unrelated
  /// to the confidentiality layer: the layer adds a condition, it does not
  /// remove this one.
  async function registerInvestor(investor: Signer, country: number) {
    const identity = await deployFrom(IdentityArtifact, investor, investor.address, false);
    const identityAddress = await identity.getAddress();

    const claimData = ethers.hexlify(ethers.toUtf8Bytes("identity verified by the issuing desk"));
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes"],
        [identityAddress, claimTopic, claimData],
      ),
    );
    const signature = await claimSigningKey.signMessage(ethers.getBytes(digest));

    await identity
      .connect(investor)
      .addClaim(claimTopic, ECDSA_CLAIM_SCHEME, await claimIssuer.getAddress(), signature, claimData, "");
    await identityRegistry.connect(tokenAgent).registerIdentity(investor.address, identityAddress, country);
    return identity;
  }

  return {
    implementationAuthority,
    claimTopicsRegistry,
    trustedIssuersRegistry,
    identityRegistryStorage,
    identityRegistry,
    compliance,
    token,
    claimIssuer,
    claimTopic,
    registerInvestor,
  };
}
