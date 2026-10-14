# Institutional confidentiality layer with zero-knowledge proofs

**Client:** VCSoft S.A.S. · **Provider:** TRU Web3

A privacy layer that lets an investor prove they are authorized to operate on a tokenized
asset (identity verified, credential valid, jurisdiction admitted) **without publishing any
of it on chain**. It sits on top of the tokenization platform without replacing it: the
compliance engine keeps deciding, it just decides against a proof instead of against a
public identity registry.

## Repository map

| Folder | What it is | Status |
|---|---|---|
| [`zk-circuits/`](zk-circuits/) | Circom circuits and their proving toolchain | Compliance circuit compiling, schemes measured |
| [`zk-contracts/`](zk-contracts/) | Hardhat: verifier boundary, registries and the compliance module | Both schemes deployed, measured and interchangeable |
| [`zk-api/`](zk-api/) | Credential issuer, authorized disclosure and the verification API | Built, specified in OpenAPI and covered by tests |
| [`zk-holder/`](zk-holder/) | Reference implementation of the investor's side and of the platform presenting the proof | Run end to end on Base Sepolia |
| [`docs/`](docs/) | Delivery records, the security and stress report, the user and operations manual, and test evidence | Records 1 and 2 delivered; manual and report written |

## What the circuit proves

Four predicates, none of which reveals who the investor is or where they live:

1. They hold a credential whose commitment is in the issuer's registry.
2. That credential is still valid at the end of the period being claimed.
3. Their jurisdiction belongs to the set the asset admits.
4. The nullifier presented derives from that credential, this asset and that period.

Revocation is enforced by removing the commitment from the registry: a revoked credential
stops proving predicate 1, and no other investor has to be reissued.

The secret behind the credential is the investor's, and the issuer never sees it. What the
investor hands over is `Poseidon(secret)`; the issuer builds the leaf from that hash and the
jurisdiction and expiry the identity check established. It can therefore still say who is
credentialed and revoke them, and it can no longer compute a nullifier or produce a proof in
anybody's name.

The proof carries one more piece of context it does not choose: an `anchor` the verifying
contract fixes to the holder being attested, the chain and its own address. Who sends the
transaction does not matter: the platform presents the holder's proof and pays for it with
`attestFor(holder, proof, signals)`, and the investor sends nothing. A proof copied from the
mempool can only attest that same holder, once, and nowhere else, and a proof for an earlier
period cannot shorten an attestation the holder already has. `attest(proof, signals)`
remains as the holder's direct route, and is `attestFor(msg.sender, …)`.

## The proving scheme is a deployment decision, not a design one

`ComplianceAttestor` holds an `IProofVerifier`: the proof reaches it as opaque bytes and the six
public signals travel apart. Behind that boundary sits one adapter per scheme, each wrapping the
verifier snarkjs generates without touching a line of it, and the attestor stores the adapter in a
variable rather than an immutable. A scheme is therefore replaced by pointing it somewhere else, and the
roles, the spent nullifiers and the attestations already granted all survive the move.

The two adapters are interchangeable rather than merely similar, which costs something: the
Groth16 verifier snarkjs generates checks that every public signal is a canonical field element
and the PLONK one does not, so the PLONK adapter closes that gap itself. Otherwise swapping the
scheme would silently swap the guarantee. `zk-contracts/test/verifier-boundary.test.ts` walks the
whole attestation twice over the same witness, once under each scheme, and gets the same nullifier,
the same period and the same event.

| | Verify | Deploy the verifier | Full attestation (`attest`) | Presented by the platform (`attestFor`) |
|---|---|---|---|---|
| Groth16 | 249 461 gas | 450 287 gas | 344 521 gas | 344 957 gas |
| PLONK | 300 256 gas | 1 549 560 gas | 399 148 gas | 399 584 gas |

Groth16 remains the choice. What changed is that it is now a reversible one.

## The API contract

`zk-api/openapi.yaml` specifies every route, request and response shape, the partner signature
scheme, the scope each route requires and the fifty-five error codes, and the service serves it at
`/api/docs`. It is held against the running application by a test: a route the router registers and
the document does not describe, an operation claiming a scope other than the one enforced, or an
error code the code can emit that the catalog does not list, all turn the suite red.

## Ports

Default ports are avoided so this project can run beside others. Every port comes from an
environment variable.

| Service | Port | Variable |
|---|---|---|
| Local Hardhat node | 8565 | `HARDHAT_PORT` |
| Verification API | 3060 | `API_PORT` |
| PostgreSQL | 5452 | `POSTGRES_PORT` |
| Redis | 6399 | `REDIS_PORT` |

## Reproducing the scheme comparison

```bash
cd zk-circuits
npm install
npx circom2 circuits/compliance.circom --r1cs --wasm --sym --output build -l node_modules -l circuits
./scripts/setup.sh          # keys for both schemes, ~4 min
npm run benchmark           # proving time, key size, proof size
node scripts/calldata.mjs   # real proofs for the on-chain measurement

cd ../zk-contracts
npm install
npm test                    # gas of verifying each proof on chain
```

## Running the service

```bash
cd zk-api
npm install
cp .env.example .env
npm run keys:generate       # a fresh set of secrets to paste into .env
docker-compose up -d        # PostgreSQL and Redis
npx prisma migrate deploy
npm test                    # 291 tests against real PostgreSQL, Redis and real proofs
npm start                   # API on 3060
```

See [`zk-api/README.md`](zk-api/README.md) for the routes, the request signing scheme and the key
rotation procedure, and [`zk-api/NOTAS-API.md`](zk-api/NOTAS-API.md) for the technical specification. Operating the system is
described in [`docs/MANUAL-USUARIO-Y-OPERACION.md`](docs/MANUAL-USUARIO-Y-OPERACION.md).
