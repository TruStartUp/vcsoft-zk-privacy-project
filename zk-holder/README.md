# zk-holder

Reference implementation of what an investor's application has to do to take part in the
confidentiality layer, plus the platform's side of presenting the proof. It is a library, not an
app: a wallet or a platform backend copies or wraps it.

```
holder (this package)                      zk-api                         chain
  secret ─ backup ─ secretHash  ──────▶  POST /v1/credentials/:id/activation ──▶ CredentialRegistry
  EIP-712 possession signature            (publishes the leaf)
  openings ◀── GET .../opening            
  anchorFor(subject), currentEpochEnd ◀────────────────────────────────────────── ComplianceAttestor
  Groth16 proof ──▶ POST /v1/verifications (bank, before presenting)
  platform: attestFor(subject, proof, signals), pays the gas ───────────────────▶ ComplianceAttestor
```

Nothing here imports `zk-api`: the EIP-712 domain, the Poseidon formulas, the backup format and the
partner signature are reimplemented, and the tests check them against the service's own code.

## Requirements

- Node 22
- The compiled circuit and the proving key that match the deployed verifier:
  `../zk-circuits/build/compliance_js/compliance.wasm`, `../zk-circuits/build/groth16.zkey` and
  `../zk-circuits/build/groth16.vkey.json`. They are build artefacts and are not committed. Never
  regenerate the keys for a live deployment: the on-chain `Groth16Verifier` was generated from
  that `groth16.zkey`, and a new key makes every proof fail on chain.
- For the tests only: `../zk-api` with its dependencies installed, because the tests compare this
  package with the issuer's own implementation.

```bash
npm install
npm run typecheck
npm test
```

## What the holder does

| Step | Function | Notes |
|---|---|---|
| Generate the secret | `generateHolderSecret()` | Rejection sampling over the BN254 scalar field. Generated once and kept; never derived from a signature the wallet may not reproduce |
| Back it up | `sealHolderSecret(secret, passphrase)` / `openHolderSecret(backup, passphrase)` | scrypt (N = 2^16, r = 8, p = 1) + AES-256-GCM, versioned. Same envelope as the issuer's reference, so either side opens the other's backups |
| Hash it | `holderSecretHash(secret)` | `Poseidon(secret)`, the only value that leaves the holder |
| Prove possession | `signActivation(account, deployment, credentialId, secretHash)` | EIP-712 `CredentialActivation(string credentialId, string secretHash)` under `{name: "VCSoft Confidentiality Layer", version: "1", chainId, verifyingContract: CredentialRegistry}`. No transaction |
| Know its leaf | `credentialCommitment(secretHash, country, expiry)` | `Poseidon(secretHash, country, expiry)`, with `expiry` in whole seconds (`expiryOf`) |
| Build the witness | `buildWitness(params)` | Takes the two openings from the API, `epochEnd = currentEpochEnd + epochLength` and `anchor = anchorFor(subject)` from `readProvingContext`. Checks every root before proving |
| Prove | `proveCompliance(input, circuitArtifacts(dir))` | Groth16 with snarkjs. Returns the proof and the `exportSolidityCallData` shape |
| Check | `verifyLocally(proof, vkeyPath)` | Against the verifying key of the deployed verifier |
| Encode | `attestorArguments(callData)` | `abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)` (256 bytes) and the six signals, for `attestFor` |

`releaseProver()` terminates snarkjs's worker pool; a process that proves has to call it, or
`process.exit`, to finish.

The body of `POST /v1/verifications` is `{ proof: callData }`.

## What the platform does

`presentForSubject(...)` submits `attestFor(subject, proof, signals)` from the platform's wallet,
which pays the gas; the holder sends nothing. It reads two reverts as what they are:

- `NullifierAlreadySpent` when `attestationOf(assetId, subject)` already carries that nullifier:
  someone presented the same proof first, and the attestation is written. Success.
- `AttestationWouldShorten(current, claimed)`: the subject is already covered past the period this
  proof claims. Nothing was spent; do not retry.

## Calling the API as a partner

```ts
const bank = new PartnerClient("http://127.0.0.1:3060", { partnerKey, secret }, "analyst-42");
const verdict = await bank.post("/v1/verifications", { proof: callData });
```

Each request is signed with HMAC-SHA256 over `VCSOFT-HMAC-SHA256`, the method, the path with its
query, the timestamp, a fresh nonce and the SHA-256 of the exact body bytes sent. The optional actor
goes in `X-Partner-Actor` and reaches the access log.

## End-to-end run on Base Sepolia

`e2e/base-sepolia.ts` drives the whole cycle against the deployed contracts and a `zk-api` running
with `.env.testnet` (see `../zk-api/README.md`): partners, investor identities in the asset's
identity registry, admitted jurisdictions, two-step issuance, local proofs, the bank's pre-check,
`attestFor` paid by the platform, mint and transfer, revocation, authorized disclosure, state rebuild
and an investor from a jurisdiction the asset does not admit.

```bash
npm run e2e:base-sepolia
```

It reads the RPC URL and the platform key from `../zk-contracts/.env` and the API port from
`../zk-api/.env.testnet`. It keeps its state (test wallet keys, partner secrets, holder backups and
every transaction) in `e2e/state/base-sepolia.json`, which is ignored by git. Run it again after an
interruption and it resumes: nothing already on chain is sent twice. It stops on its own if the
platform wallet spends more than 0.005 ETH or the deployer more than 0.002 ETH. Every line it prints
is also appended to the raw log under `../docs/evidencias/`, with keys, partner secrets, holder
secrets and backup passphrases replaced by `[redacted]`.

## Layout

```
src/
  field.ts           field order, uniform sampling
  poseidon.ts        the circuit's hash
  secret.ts          secret, secretHash, sealed backup
  credential.ts      commitment, nullifier, expiry encoding
  possession.ts      EIP-712 domain and activation signature
  merkle.ts          root from an opening, as the circuit computes it
  witness.ts         circuit input, checked before proving
  prover.ts          Groth16 proof, calldata, attestFor encoding
  chain.ts           attestor ABI, proving context read at one block
  presenter.ts       attestFor from the platform, with the two benign reverts
  partner-client.ts  signed HTTP client
e2e/                 the Base Sepolia run
test/                unit tests, no network
```
