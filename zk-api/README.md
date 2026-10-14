# zk-api

Credential issuer, authorized disclosure service and verification API for the confidentiality
layer.

Three things live here, in one service because they share one trust boundary, which is the only
place where a holder's identity, the issuing key and the viewing keys are handled at all:

1. **Credential issuer.** Turns an identity verification the bank already performed into a
   credential, keeps both Merkle trees off chain, publishes their roots to `CredentialRegistry`,
   and revokes by removing a leaf. It can rebuild its whole tree state from the registry's own
   event log. Issuance happens in two steps, because the value at the heart of a credential
   belongs to the holder: see [below](#issuing-a-credential-in-two-steps).
2. **Authorized disclosure.** Stores each holder's identity sealed against a viewing key whose
   private half never reaches the database, and releases only the attributes an approved request
   names, leaving a non-repudiable record of who asked, why, over what and when.
3. **Verification API.** The five capabilities the delivery record commits to, for bank systems:
   validate a proof and ask whether it still stands, read the compliance state of a position
   without any personal data, read a credential's status from its commitment, request a
   disclosure and follow it, and read the access history.

The contract is specified in [`openapi.yaml`](openapi.yaml) and served by the service itself, so
the routes below are a summary and that document is the source: **`GET /api/docs`** renders it and
**`GET /api/openapi.yaml`** hands it over. Both are public. A test fails if a route the application
registers is missing from it, if an operation claims a scope other than the one the route enforces,
or if an error code the code can emit is not in its catalog, so it cannot quietly stop being true.

## Where it sits

```
identity verification (bank)  ──▶  zk-api  ──▶  CredentialRegistry   (roots, leaf events)
                                     │
bank / regulator  ──signed HTTP──────┘     ──▶  ComplianceAttestor   (attestations, nullifiers)
```

The circuit, the verifier and the registries are in [`../zk-circuits`](../zk-circuits) and
[`../zk-contracts`](../zk-contracts). This service never decides compliance on chain; it prepares
what the holder needs to prove it, and answers questions about what the chain already holds. The
proof itself is presented by the platform acting for the holder, through
`ComplianceAttestor.attestFor(subject, proof, signals)`; this service sends no attestation and
only reads what one left behind.

## Requirements

- Node 22
- Docker, for PostgreSQL and Redis
- A reachable EVM RPC endpoint with the registry and attestor deployed
- The verifying key of the deployed circuit, for the scheme the attestor has an adapter mounted
  for (`groth16.vkey.json` or `plonk.vkey.json`)

## Getting it up

```bash
npm install
cp .env.example .env
npm run keys:generate          # prints a fresh set of secrets; paste them into .env
docker-compose up -d           # PostgreSQL on 5452, Redis on 6399
npx prisma migrate deploy
npm start                      # API on 3060
curl http://127.0.0.1:3060/health
open http://127.0.0.1:3060/api/docs
```

Every port comes from an environment variable and nothing falls back to a default, so the
service can run beside others without colliding.

| Service | Port | Variable |
|---|---|---|
| API | 3060 | `API_PORT` |
| PostgreSQL | 5452 | `POSTGRES_PORT` |
| Redis | 6399 | `REDIS_PORT` |
| Local chain node of this project | 8565 | `HARDHAT_PORT` (in `../zk-contracts`) |

### A second environment beside the local one

The service reads `.env` unless `DOTENV_CONFIG_PATH` names another file, so the same checkout can
run against Base Sepolia without touching the configuration the suite uses:

```bash
cp .env.example .env.testnet          # ignored by git, like every .env.*
# CHAIN_ID=84532, the registry and attestor addresses and REGISTRY_DEPLOYMENT_BLOCK from
# ../zk-contracts/deployments/baseSepolia.json, CHAIN_CONFIRMATIONS=2, the platform key as
# ISSUER_PRIVATE_KEY, fresh secrets from `npm run keys:generate`, and stores of its own:
#   DATABASE_URL=postgresql://…@127.0.0.1:5452/zkapi_testnet?schema=public
#   REDIS_URL=redis://127.0.0.1:6399/1
docker exec zk-api-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE DATABASE zkapi_testnet"'
npm run prisma:migrate:testnet
npm run start:testnet
DOTENV_CONFIG_PATH=.env.testnet npm run partner:create -- "bank-core" proofs:verify proofs:read
```

Use a database and a Redis logical database of their own: `npm test` truncates the database named by
`TEST_DATABASE_URL` and flushes the Redis database it uses.

### Secrets

Four, all read from the environment and none of them ever written to the database. In production
they belong in the client's cloud secret manager.

None of them can reconstruct a holder's credential secret: that value is generated in the holder's
wallet and never reaches this service.

| Variable | What it is |
|---|---|
| `SUBJECT_REFERENCE_KEY` | Blinds the bank's KYC identifier. Losing it costs the duplicate check, not a credential. |
| `DISCLOSURE_VIEWING_KEYS` | X25519 private keys, `id:base64` pairs. Only these open a sealed identity. |
| `PARTNER_SECRET_ENCRYPTION_KEY` | Wraps partner HMAC secrets at rest. |
| `ACCESS_LOG_HMAC_KEY` | Chains the append-only access log. Without it the chain cannot be forged. |

## Testing

```bash
npm run typecheck
npm test
```

`npm test` runs `prisma migrate deploy` against `TEST_DATABASE_URL` first, then the whole suite
against real PostgreSQL and real Redis. Only the chain is stood in for, in two ways:

- **A stub of the registry and the attestor** (`test/helpers/registry-stub.ts`) that keeps the
  state the contracts keep (current root, superseded roots, spent nullifiers, the event log, the
  roots as they stood at every block) and reverts the way they do (`RootUnchanged`,
  `RootIsCurrent`, `UnknownRoot`). It can make `latest` lag behind, which is how the suite checks
  that no decision rests on a stale read.
- **A scripted JSON-RPC node** (`test/helpers/fake-node.ts`) behind the real viem clients, for what
  only shows up below the service: rate limiting, gateway errors, slow receipts, confirmations,
  capped `eth_getLogs` ranges, a lagging head and a stale transaction count.

Proof verification is not stubbed: `test/fixtures/compliance-proofs.json` holds real proofs
generated from the compiled circuit (the same witness proved under **both** schemes), and
`groth16.vkey.json` and `plonk.vkey.json` are the verifying keys they were made with. The Merkle
tests check this service's trees against the roots those same fixtures were built from, so a
divergence in padding, hash arity or sibling order fails here rather than on chain.

## Stress runs

`stress/` drives the service as a partner would, against a local Hardhat node on port 8565, its own
database (`zkapi_stress`) and Redis index 2, with the service on port 3071. None of it is part of
`npm test`.

```bash
cd ../zk-contracts && npm run node        # in another terminal
cd ../zk-api && npm run stress:setup      # fresh contracts, .env.stress, empty stores, partners
npm run stress:s4                         # then s1, s2, s3, s5, s8, s9, s10, s11, s12
npm run stress:s6                         # proving time, no service
npm run stress:s13                        # Base Sepolia, bounded spend, uses .env.testnet
```

Each script prints what it measured and the service's own log summary; working state goes to
`stress/out/`, which is not committed. `../zk-contracts` has `npm run stress:gas` for gas against
tree and batch size.

## Calling it

Every `/v1` route is authenticated by an HMAC signature over the request, and authorized by a
scope. Bearer tokens are deliberately not used: a leaked token is a standing grant, whereas a
signature covers one method, one path, one body and one moment.

### Headers

| Header | Content |
|---|---|
| `X-Partner-Key` | The partner's key id |
| `X-Partner-Timestamp` | Unix seconds. Outside `PARTNER_SIGNATURE_WINDOW_SECONDS` the request is refused. |
| `X-Partner-Nonce` | 8–128 characters, single-use inside the window |
| `X-Partner-Signature` | Hex HMAC-SHA256 over the canonical request |
| `X-Partner-Actor` | Optional. The person the partner is acting for; it reaches the access log. |

### The canonical request

```
VCSOFT-HMAC-SHA256\n
<METHOD>\n
<path including its query string>\n
<timestamp>\n
<nonce>\n
<hex sha256 of the raw body>
```

```js
const canonical = [
  "VCSOFT-HMAC-SHA256",
  "GET",
  "/v1/access-log?limit=50",
  timestamp,
  nonce,
  createHash("sha256").update(body).digest("hex"),
].join("\n");
const signature = createHmac("sha256", partnerSecret).update(canonical, "utf8").digest("hex");
```

Registering a partner:

```bash
npm run partner:create -- "bank-core" proofs:verify proofs:read compliance:read
```

The secret is printed once and only its wrapped form is kept. Suspending, reactivating and
rotating a partner's secret:

```bash
npm run partner:list
npm run partner:suspend -- <partnerKey>        # its next request gets 403 partner_suspended
npm run partner:reactivate -- <partnerKey>
npm run partner:rotate-secret -- <partnerKey>  # new secret printed once; the old one stops verifying
```

### Scopes

`proofs:verify` · `proofs:read` · `compliance:read` · `credentials:read` · `credentials:issue` ·
`credentials:activate` · `credentials:revoke` · `credentials:opening` · `jurisdictions:write` ·
`disclosures:request` · `disclosures:read` · `disclosures:approve` · `audit:read` · `issuer:admin`

`credentials:issue` and `credentials:activate` are deliberately separate: the desk that registers
the bank's verdict must not be able to complete the credential in the holder's place.

`credentials:opening` is read-only and is the one the platform building proofs for the holder
needs. Scopes are not hierarchical: `issuer:admin` does not include it, so the operator who
rebuilds state and rotates viewing keys does not read openings unless granted them on purpose.

### Routes

The full contract, with request and response schemas, is in [`openapi.yaml`](openapi.yaml) and at
`/api/docs`.

| Route | Scope | What it does |
|---|---|---|
| `GET /health` | None | Liveness. Public. |
| `GET /api/docs` | None | This service's specification, rendered. Public. |
| `GET /api/openapi.yaml` | None | The specification itself. Public. |
| `POST /v1/credentials` | `credentials:issue` | Registers an approved verification and returns a pending credential |
| `POST /v1/credentials/:credentialId/activation` | `credentials:activate` | The holder supplies `secretHash`, proves the wallet, and the root is published |
| `POST /v1/credentials/:credentialId/cancellation` | `credentials:revoke` | Retires an enrolment the holder never completed |
| `GET /v1/credentials/:commitment` | `credentials:read` | Status: active, suspended, expired or revoked |
| `GET /v1/credentials/:commitment/opening` | `credentials:opening` | The Merkle opening a wallet needs to prove |
| `POST /v1/credentials/:commitment/revocation` | `credentials:revoke` | Removes the leaf, republishes, and closes the superseded root's window; retires a suspended credential without publishing |
| `POST /v1/credentials/:commitment/suspension` | `credentials:revoke` | Same, reversibly |
| `DELETE /v1/credentials/:commitment/suspension` | `credentials:revoke` | Puts the leaf back |
| `PUT /v1/assets/:assetId/jurisdictions` | `jurisdictions:write` | Replaces the admitted set, republishes, and closes the superseded root's window when a country is withdrawn |
| `GET /v1/assets/:assetId/jurisdictions/:countryCode/opening` | `credentials:opening` | The jurisdiction opening |
| `POST /v1/verifications` | `proofs:verify` | Validates a proof against the current chain state |
| `GET /v1/verifications/:id` | `proofs:read` | Whether that proof still stands |
| `GET /v1/compliance/assets/:assetId/subjects/:subject` | `compliance:read` | Compliance state, no personal data |
| `POST /v1/disclosures` | `disclosures:request` | Opens a disclosure request |
| `GET /v1/disclosures/:id` | `disclosures:read` | Its state |
| `POST /v1/disclosures/:id/decision` | `disclosures:approve` | Approves or denies it. Never by the partner that asked |
| `POST /v1/disclosures/:id/release` | `disclosures:read` | Releases the approved attributes, to the partner that asked only |
| `POST /v1/disclosures/viewing-keys/rotation` | `issuer:admin` | Re-seals envelopes onto the active key |
| `GET /v1/access-log` | `audit:read` | The access history |
| `GET /v1/access-log/integrity` | `audit:read` | Verifies the chain and names the first break |
| `POST /v1/issuer/state/rebuild` | `issuer:admin` | Replays the registry's events and reconciles |
| `POST /v1/issuer/assets/:assetId/state/rebuild` | `issuer:admin` | The same for one asset's jurisdiction tree |

### Errors

Every error carries a stable `code` in `snake_case` next to the HTTP status, so a caller branches
on the code rather than on prose. The complete catalog (fifty-five codes, each with the status it is
returned under and what it means) is `x-error-catalog` in [`openapi.yaml`](openapi.yaml), and a
test fails if the code can emit one that is not in it.

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "this partner does not hold the scope this route needs",
  "code": "insufficient_scope",
  "details": { "required": "audit:read", "granted": ["proofs:verify"] }
}
```

Nothing is ever answered with a value that could not be computed. If the verifying key is
unreachable, `verification_key_unavailable` comes back, never a verdict nobody computed.

At capacity the answer is `service_busy` (503) with a `Retry-After` header, and nothing was
changed: either more than `ISSUER_WRITE_QUEUE_LIMIT` tree changes are already waiting on one tree
(`details.reason: issuer_write_queue_full`), or no database connection came free in time
(`database_saturated`).

## Separation of parties in a disclosure

The party that approves a disclosure is never the party that asked for it, and that is enforced
per request, whatever scopes either partner holds:

- `POST /v1/disclosures/:id/decision` from the partner that made the request is refused with
  `disclosure_self_decision` (403), approving or denying alike. A check constraint in the database
  refuses the same row, so a write that goes around the service cannot record it either.
- `POST /v1/disclosures/:id/release` from any partner other than the one that made the request is
  refused with `disclosure_not_requester` (403), before the request's status is looked at.
- Who decided is recorded from the authenticated request: `decidedByPartnerKey` and the
  `X-Partner-Actor` it named, `decidedByActor`. `decidedBy` in the body is optional and kept only
  as what the partner declared.

## Running against a public RPC

A public endpoint rate-limits, sits behind a load balancer whose backends can be a block or two
apart, and caps how many blocks one `eth_getLogs` may span. The client is built for that:

- **Retries.** Every JSON-RPC request is retried on HTTP 408/425/429/5xx, a rate limit reported as a
  JSON-RPC error (code 429), timeouts, dropped connections and a node that has not caught up with
  the requested block, with exponential
  backoff (`CHAIN_RPC_RETRY_BASE_MS` doubled per attempt, honouring `Retry-After` up to 30 s) up to
  `CHAIN_RPC_MAX_RETRIES`. A revert is never retried: it is the contract's answer. A raw
  transaction resent after a lost response that comes back "already known", or "nonce too low"
  while the node holds that very transaction, is taken as sent.
- **Confirmations and receipts.** A write counts as done after `CHAIN_CONFIRMATIONS` blocks, within
  `CHAIN_RECEIPT_TIMEOUT_MS`. Past that the answer is `chain_receipt_timeout` with the transaction
  hash: the transaction may still be mined, so reconcile (`POST /v1/issuer/state/rebuild`) before
  writing again. A receipt that lags behind its transaction is waited for, not taken as a failure.
  Repeating the same change after such a transaction was mined adopts it: the registry already
  holds the root the change computes, so the service finds the publication that put it there and
  records it instead of failing on `RootUnchanged`.
- **No stale `latest`.** The root a publication replaced is read from the publication's own
  receipt (`CredentialRootPublished` / `CountryRootPublished`), not from a read made before it, and
  it is what revocation and suspension invalidate. The admitted-set comparison uses the tree this
  service published. Every read of one answer (a verification, a standing, a compliance state, a
  rebuild) is made at a single block, never earlier than the last block this process saw its own
  transaction confirmed in, and gas for a write is estimated at that block too.
- **Nonces.** The issuer's nonces are the larger of the node's pending count and the next one this
  process has not used, so a lagging node cannot hand out a nonce again. Transactions leave the
  process one at a time, so changes to different trees never share a nonce. One process signs with
  the issuer key.
- **Log windows.** A rebuild reads the event log in windows of `CHAIN_LOG_BLOCK_RANGE` blocks, and
  halves a window the node still refuses. If the RPC provider in use caps that span, set
  `CHAIN_LOG_BLOCK_RANGE` to its cap.

| Variable | Default | What it sets |
|---|---|---|
| `CHAIN_CONFIRMATIONS` | `1` | Confirmations per write. Use `2` on Base Sepolia |
| `CHAIN_RECEIPT_TIMEOUT_MS` | `90000` | Wait for a receipt |
| `CHAIN_POLLING_INTERVAL_MS` | `1000` | Polling of receipts and blocks |
| `CHAIN_RPC_TIMEOUT_MS` | `15000` | Time limit of one request |
| `CHAIN_RPC_MAX_RETRIES` | `4` | Retries of a transient failure |
| `CHAIN_RPC_RETRY_BASE_MS` | `250` | First backoff, doubled per retry |
| `CHAIN_LOG_BLOCK_RANGE` | `2000` | Largest span of one `eth_getLogs` |

All are validated at startup. A tree change holds its database transaction across up to two
confirmed writes, so its time limit follows from the receipt timeout. Changes to one tree run one
at a time and wait in memory, not on a pooled connection; `ISSUER_WRITE_QUEUE_LIMIT` (default `16`)
bounds how many may wait.

## Verifying a proof, and under which scheme

A deployment verifies under one proving scheme, named by `PROOF_SCHEME`, and it has to be the one
`ComplianceAttestor` has an adapter mounted for. `POST /v1/verifications` takes the
`exportSolidityCallData` shape of either scheme (`{a, b, c, signals}` for Groth16, `{proof,
signals}` for PLONK) and refuses the one this deployment does not verify with
`proof_scheme_mismatch` rather than calling a perfectly good proof invalid. The verdict carries the
scheme that reached it, and so does the standing of that verdict afterwards.

The checks are the ones `ComplianceAttestor` applies before the pairing on either entry,
`attestFor` or `attest`, except the anchor: it binds the proof to a subject, and a verification
request does not name one. A proof that verifies here can still be refused on chain if it is
presented for a subject other than the one it was built for.

How a proof is written down lives in `src/lib/proof-codec.ts` and nowhere else. That is where the
Groth16 Fp2 coordinate swap of `exportSolidityCallData` is undone (a Groth16 detail, since PLONK
commits to nothing over Fp2), and it is why switching schemes is a configuration change rather
than a rewrite. See `NOTAS-API.md` §5.4.

## Issuing a credential in two steps

The issuer does not know, and cannot compute, the holder's secret. The leaf it publishes is

```
commitment = Poseidon(secretHash, country, expiry)      secretHash = Poseidon(secret)
nullifier  = Poseidon(secret, assetId, epochEnd)
```

so it can fix the jurisdiction and the expiry the identity check established while holding no
preimage, and therefore no nullifier and no proof it could present as somebody else.

That splits issuance in two.

**1 · The bank's verdict.** `POST /v1/credentials` carries the verdict, the identity to seal and
`holderAddress`, the wallet the check was performed against. The row is created `PENDING`: no
commitment, no leaf position, nothing published. The response carries the credential's identifier
and the two EIP-712 messages the holder's wallet will be asked to sign.

**2 · The holder's secret.** The holder's application derives the secret in the wallet, sends
`POST /v1/credentials/:credentialId/activation` with `secretHash` and a signature, and only then is
the leaf built and the root published.

### What the wallet signs, and why it is two messages

```
domain = { name: "VCSoft Confidentiality Layer", version: "1", chainId, verifyingContract: <CredentialRegistry> }

CredentialSecret(string statement)                      → never leaves the holder's process
CredentialActivation(string credentialId, string secretHash)  → sent to the issuer as proof
```

- **The derivation message never travels.** Whoever holds that signature holds the credential for
  good, so it is not what proves possession. Activation is a *different* message, which reveals
  nothing about the secret and cannot be replayed onto another pending credential.
- **The proof of possession is not optional.** Without it the issuer could substitute a
  `secretHash` of its own (the resulting commitment would be indistinguishable from a legitimate
  one), and anyone who learned a pending credential's identifier could get in first with theirs.
- **EIP-712, not `personal_sign`.** A fixed unstructured string is exactly the shape phishing
  already uses: no gas, no warning about moving funds. Typed data makes the wallet show the
  requesting origin and the content.
- **The domain names this deployment.** Without it the same wallet would yield the same
  `secretHash` everywhere, and two credentials at two institutions would be linkable by comparing
  one number. It matters more than it looks: a leaked `secretHash` is enough to brute-force the
  country and the expiry out of the published commitment: a few hundred codes times a few
  thousand plausible expiries is around 10^5 Poseidon evaluations.

Both are requested over `eth_signTypedData_v4`, and that is pinned: the RPC method, the domain and
the struct definitions together are the version of the scheme. Changing any of them changes every
secret ever derived under it, which is a reissuance of the whole population.

`src/lib/holder-secret.ts` is the reference implementation, and it is the client's to run. The
issuer imports only `recoverActivationSigner` from it.

### The reduction, and why it is what it is

```
secret = SHA-512( "vcsoft/zk-api/holder-secret/v1" || r || low-s(s) ) mod p
```

The recovery byte is dropped, since wallets disagree on 27/28 versus 0/1, and `s` is folded to its low
half, because `(r, s)` and `(r, n − s)` are both valid signatures of the same message and a client
that did not normalise would derive a second, equally valid secret and lose the credential built on
the first.

### Do not treat the signature as a key derivation function

Rebuilding a secret from a signature only works if the wallet produces the **same signature bytes**
for the same message, years apart. That is a property of RFC 6979 deterministic ECDSA, not of the
signature scheme, and **no wallet standard requires it** (see `NOTAS-API.md` §2.3). Wallets that
sign with a random nonce, or whose key changes with the login method, cannot reproduce it.

So the client's job is to **generate the secret once and keep it**:

```ts
const secret = randomHolderSecret();                       // or holderSecretFromSignature(...)
const backup = sealHolderSecret(secret, passphrase);       // scrypt + AES-256-GCM, versioned
const secretHash = await holderSecretHash(secret);         // the only value that travels
```

Hand the backup to the holder before activating. Recovery is then a decryption, not a re-signature.
The derivation path stays supported and tested, since for a software EOA it is convenient and
there is nothing to custody, but it is never the only copy.

| Wallet | Signature reproducible |
|---|---|
| Software EOA with deterministic ECDSA | Yes |
| Embedded / email-login wallet | Undocumented at best; threshold signers, never |
| MPC / threshold signer | No. Indistinguishable from an EOA on chain, so this service cannot refuse it |
| Contract account (ERC-1271, ERC-4337) | Not applicable. **Refused at activation** (`holder_is_contract_account`) |

Migrating a holder to a contract or MPC account means revoking and reissuing. Note also that the
*key* can change under you: with some providers, signing in with Google and with an email link for
the same address are different verifiers and therefore different wallets.

**One switch to know about if you build the client on viem:** `setSignEntropy()` turns on RFC 6979's
optional extra entropy for every signature the process makes afterwards, which makes the derivation
non-reproducible. It is a module-level global, it is off by default, and any transitive dependency
can flip it. Do not turn it on, and pin the viem version.

### Losing the wallet

Nobody can rescue a holder who loses their wallet, not even the issuer, which is the price of
the change. The way back is a fresh identity check, `POST /v1/credentials/:commitment/revocation`
on the old credential, and a new issuance for the same subject: a revoked credential no longer
holds the subject's one live slot. An enrolment abandoned before activation is retired with
`.../cancellation`, which publishes nothing because nothing was ever published for it.

## Revoking immediately

Removing a leaf is not, by itself, immediate. The superseded root stays acceptable to the
registry for `rootValidityWindow`, and against it the revoked commitment still proves membership.
Both revocation and suspension therefore also call `invalidateCredentialRoot` on the superseded
root, which drops that window to zero.

The cost is stated in the response as `previousRootInvalidated`, because it is real: proofs other
holders built against that root in the last minutes are refused too. They lose nothing (they
fetch their opening again and re-prove), but an operator who would rather not disturb them sends
`{"closeRootWindow": false}` and accepts the latency instead.

If the publication goes through and only the closure fails, the change stands: the answer is
`424 root_invalidation_pending`, the closure is recorded as pending, and repeating the same request
closes it. Withdrawing a country from an asset closes the superseded country root the same way,
unless the request says `"closeRootWindow": false`.

A suspended credential is already out of the tree, so revoking it retires it without publishing
anything, expired or not, and frees its subject.

This closes only one of the two windows. An attestation already granted lives until the end of the
period it claimed; cutting that one is `ComplianceAttestor.revokeAttestation`, on chain
(`npx hardhat attestation:revoke` in `zk-contracts`, which also has `token:freeze` and
`token:unfreeze` for the token's balances).

## Rotating a viewing key

1. Generate a keypair (`npm run keys:generate` prints one) and give it a new id.
2. Add it to `DISCLOSURE_VIEWING_KEYS` **beside** the current one and point
   `DISCLOSURE_ACTIVE_VIEWING_KEY` at it. New credentials seal against it immediately.
3. `POST /v1/disclosures/viewing-keys/rotation` until `remaining` comes back `0`. Each envelope is
   opened with its own key and re-sealed under a fresh ephemeral key; one that cannot be opened is
   listed in `failed` and walked past, so it never hides the rest.
4. Only then remove the superseded key from `DISCLOSURE_VIEWING_KEYS`. Removing it earlier leaves
   envelopes nobody can open. The data is not lost, but it is unreadable until the key comes back.

Nothing about a rotation touches the chain: viewing keys have no role in what is proven.

## Recovering the issuer's state

The registry emits every leaf change, so the trees can be rebuilt from the chain alone:

```bash
npm run issuer:rebuild -- 42 43     # asset ids whose jurisdiction trees to rebuild too
```

It replays `CredentialLeafUpdated` and `CountryLeafUpdated` in block order, compares the result
with the roots the registry currently holds and every tree with the database, and prints the
reports followed by `{"healthy", "problems"}`. It exits non-zero when any tree's replay misses the
registry's root, when the chain and the database disagree on a commitment or a country, or when a
window closure is still pending. Disagreements are named, never repaired silently: a commitment
the chain carries and the database does not is a lost identity envelope, which is an incident.

## Layout

```
src/
  config/      environment, validated with Joi at startup
  lib/         field arithmetic, Poseidon, Merkle trees, sealed boxes, HMAC, the hash chain, viem
               with its retrying transport and nonce tracking,
               proof-codec.ts, the one module that knows how a proof is written down, and
               holder-secret.ts, the client-side reference derivation
  middleware/  partner authentication, scopes, validation, access log, error handling
  services/    issuance and activation, trees, registry, disclosure, proof verification, compliance, audit
  routes/      HTTP shape, validation and authorization only, plus the two that serve openapi.yaml
openapi.yaml   the contract, served at /api/docs and checked against the router by the suite
prisma/        schema and migrations
scripts/       operator tools
test/          the suite, with real proof fixtures
```

Routes never reach past a service into Prisma except for trivial reads. Services own the business
rules and the chain. `lib` knows nothing about HTTP.
