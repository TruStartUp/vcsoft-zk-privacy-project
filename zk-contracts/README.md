# zk-contracts

Hardhat project with the on-chain half of the confidentiality layer: `CredentialRegistry`,
`ComplianceAttestor`, the Groth16 and PLONK verifier adapters behind `IProofVerifier`, and
`ZKComplianceModule`, the ERC-3643 compliance module that admits a receiver only with a live
attestation.

```bash
npm install
npx hardhat test
```

## Deploying to Base Sepolia

Base Sepolia (`chainId` 84532) is the only network the deploy script accepts.

Create `.env` from `.env.example`:

| Variable | Used for |
|---|---|
| `BASE_SEPOLIA_RPC_URL` | RPC endpoint; falls back to `https://sepolia.base.org` |
| `DEPLOYER_PRIVATE_KEY` | Wallet X: deploys the layer, administers the registry and the attestor, owns the module and the asset |
| `PLATFORM_PRIVATE_KEY` | Wallet Y: owner of the shared `TREXFactory`, deploys the T-REX suite and unpauses the token |
| `ETHERSCAN_API_KEY` | Etherscan API v2 key, used for Basescan verification |

```bash
npm run deploy:base-sepolia   # deploy, or resume an interrupted deployment
npm run verify:base-sepolia   # publish the sources on Basescan
npm run check:base-sepolia    # read-only check of the on-chain wiring
```

`scripts/deploy.ts` does this, in order:

1. With X: `Groth16Verifier`, `Groth16VerifierAdapter`, `CredentialRegistry(X, 900)`,
   `ComplianceAttestor(X, registry, adapter, 30 days)`, the `ZKComplianceModule` implementation
   and the standard's `ModuleProxy` with `initialize(attestor)`.
2. With X: `ISSUER_ROLE` and `JURISDICTION_ROLE` on the registry and `ATTESTATION_MANAGER_ROLE`
   on the attestor, granted to Y.
3. With Y: `TREXFactory.deployTREXSuite` with the module proxy as the only compliance module and
   `setAssetId(ASSET_ID)` as its setting, then `Token.unpause()`. Without `PLATFORM_PRIVATE_KEY`
   the script stops before this step and a later run picks it up from the recorded state.

The deployment on Base Sepolia is complete: the T-REX suite was created in a third run that
resumed from the record without resending any transaction. Its addresses are in
`deployments/baseSepolia.json`, and `npm run check:base-sepolia` passes 40 of 40 checks.

Before sending anything it checks that X owns the T-REX implementation authority, that Y is
the factory owner and that both hold at least 0.03 ETH. It sends one transaction at a time, waits
for two confirmations and polls until the new state is readable, because the public RPC can
answer from a node that is a few blocks behind.

Every address, transaction hash, block, signer and fee is written to
`deployments/baseSepolia.json`. A hash is recorded before its receipt is awaited. A second
run skips what is confirmed and picks up a pending transaction instead of sending it again. The
salt, asset id and token details are fixed in the script, and the script will not mix a record
written with other values.

`REGISTRY_DEPLOYMENT_BLOCK` for `zk-api` is `contracts.credentialRegistry.block` in that file.

### Verification

`scripts/verify-explorer.ts` verifies the five project contracts through `hardhat-verify` and
tolerates contracts that are already verified. `ModuleProxy` is deployed from the bytecode that
`@erc3643org/erc-3643` publishes. The package ships no build info, and compiling it here puts
the source under a different path, which changes the metadata hash. The script rebuilds the
standard JSON input with the package's original source path
(`contracts/compliance/modular/modules/ModuleProxy.sol`), which reproduces the published bytecode
exactly, and submits it straight to the Etherscan v2 API.

## Operator tasks

Hardhat tasks for what an operator does on chain after a revocation, defined in
`scripts/operations.ts`:

```bash
npx hardhat attestation:revoke --network baseSepolia --subject <address> [--asset <id>] [--dry-run]
npx hardhat token:freeze       --network baseSepolia --holder <address> [--amount <tokens>] [--dry-run]
npx hardhat token:unfreeze     --network baseSepolia --holder <address> [--amount <tokens>] [--dry-run]
```

`attestation:revoke` calls `ComplianceAttestor.revokeAttestation`; the freeze tasks call the T-REX
agent functions `setAddressFrozen`, or `freezePartialTokens` / `unfreezePartialTokens` with
`--amount`. The attestor, the token and the asset id come from `deployments/<network>.json` unless
`--attestor`, `--token` or `--asset` say otherwise. Each task checks the signer's role and the
current state first, says so and sends nothing when there is nothing to do, prints the state before
and after, and waits for two confirmations on Base Sepolia. `--dry-run` checks without sending.

On Base Sepolia they sign with `PLATFORM_PRIVATE_KEY`, the wallet that holds
`ATTESTATION_MANAGER_ROLE` and is the token's agent. On a local node (`--network localhost`) they
use the first unlocked account that holds the role. Any other chain is refused. They are tested in
`test/operations.test.ts` and were run against a local node; they have not been run against Base
Sepolia.
