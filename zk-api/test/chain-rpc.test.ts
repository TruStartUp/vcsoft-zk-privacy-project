import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { TimeoutError, createPublicClient, hexToBigInt, numberToHex, parseTransaction, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config/index.js";
import { configureChain, isTransientRpcError, retryingTransport, type ChainSettings } from "../src/lib/chain.js";
import { CREDENTIAL_TREE_DEPTH } from "../src/lib/field.js";
import { replayLeafUpdates } from "../src/lib/merkle.js";
import { poseidonHash } from "../src/lib/poseidon.js";
import {
  fetchCredentialLeafEvents,
  findCredentialRootPublication,
  invalidateCredentialRoot,
  publishCountryRoot,
  publishCredentialRoot,
  readCredentialRoot,
  stateBlock,
} from "../src/services/registry.service.js";
import { rebuildCredentialTreeFromChain } from "../src/services/tree.service.js";
import { FakeNode, httpError, revertError, rpcError } from "./helpers/fake-node.js";

/// These tests drive the real viem clients and the real registry service against a
/// scripted node, because what a public endpoint does to a client -- rate limits,
/// lag, slow receipts, capped log ranges -- only shows up below the service.

let node: FakeNode;

const fast: Partial<ChainSettings> = {
  retry: { maxRetries: 3, baseDelayMs: 2 },
  pollingIntervalMs: 10,
  receiptTimeoutMs: 3_000,
  confirmations: 1,
};

function useNode(settings: Partial<ChainSettings> = {}) {
  node = new FakeNode();
  configureChain({ transport: node.transport(), settings: { ...fast, ...settings } });
  return node;
}

beforeEach(() => {
  useNode();
});

afterEach(() => {
  configureChain();
});

describe("retrying a public endpoint", () => {
  it("retries a 429 and returns the answer that follows it", async () => {
    node.failNext(1, () => httpError(429), "eth_blockNumber");
    node.head = 4242n;

    expect(await stateBlock()).toBe(4242n);
    expect(node.callsOf("eth_blockNumber")).toHaveLength(2);
  });

  it("retries timeouts, gateway errors and a node that has not seen the block yet", async () => {
    node.failNext(1, () => new TimeoutError({ body: {}, url: "http://fake-node.invalid" }), "eth_call");
    node.failNext(1, () => httpError(502), "eth_call");
    node.failNext(1, () => rpcError(-32000, "header not found"), "eth_call");
    node.credentialRoot = 77n;

    expect(await readCredentialRoot()).toBe(77n);
    expect(node.callsOf("eth_call")).toHaveLength(4);
  });

  /// How the Base Sepolia provider answers past its compute-unit budget: not an HTTP 429
  /// but a JSON-RPC error with code 429 inside the response. Found by the testnet run,
  /// where it failed whole rebuilds.
  it("retries a rate limit that arrives as a JSON-RPC error instead of an HTTP status", async () => {
    node.failNext(
      2,
      () => rpcError(429, "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message."),
      "eth_getLogs",
    );
    node.head = 50n;

    expect(await fetchCredentialLeafEvents(0n, 50n)).toEqual([]);
    expect(node.callsOf("eth_getLogs")).toHaveLength(3);
  });

  it("backs off exponentially between attempts", async () => {
    useNode({ retry: { maxRetries: 3, baseDelayMs: 20 } });
    node.failNext(3, () => httpError(429), "eth_blockNumber");

    await stateBlock();
    const times = node.callsOf("eth_blockNumber").map((call) => call.at);
    const gaps = times.slice(1).map((time, i) => time - times[i]!);

    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(18);
    expect(gaps[1]).toBeGreaterThanOrEqual(38);
    expect(gaps[2]).toBeGreaterThanOrEqual(78);
  });

  it("gives up after the configured attempts and says the chain failed", async () => {
    node.failNext(10, () => httpError(429), "eth_call");

    await expect(readCredentialRoot()).rejects.toMatchObject({
      output: { statusCode: 424, payload: { code: "chain_call_failed" } },
    });
    expect(node.callsOf("eth_call")).toHaveLength(4);
  });

  it("never retries a revert", async () => {
    node.failNext(1, () => revertError("RootIsCurrent", [5n]), "eth_estimateGas");

    await expect(invalidateCredentialRoot(5n)).rejects.toMatchObject({
      output: { statusCode: 424, payload: { code: "root_invalidation_reverted", details: { revert: { error: "RootIsCurrent", args: ["5"] } } } },
    });
    expect(node.callsOf("eth_estimateGas")).toHaveLength(1);
    expect(node.callsOf("eth_sendRawTransaction")).toHaveLength(0);
  });

  it("does not retry a request the node refuses outright", async () => {
    node.failNext(1, () => httpError(400), "eth_call");
    await expect(readCredentialRoot()).rejects.toMatchObject({ output: { payload: { code: "chain_call_failed" } } });
    expect(node.callsOf("eth_call")).toHaveLength(1);
  });

  it("keeps the provider URL out of what a caller sees", async () => {
    node.failNext(10, () => httpError(503), "eth_call");
    const error = await readCredentialRoot().catch((cause) => cause);
    expect(JSON.stringify(error.output.payload)).not.toContain("fake-node.invalid");
  });

  it("takes an 'already known' answer to a resent transaction as the transaction it is", async () => {
    node.dropNextResponse("eth_sendRawTransaction");

    const published = await publishCredentialRoot(11n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);

    expect(node.callsOf("eth_sendRawTransaction")).toHaveLength(2);
    expect(node.sent).toHaveLength(1);
    expect(published.txHash).toBe(node.sent[0]!.hash);
  });

  it("classifies the errors it retries and the ones it does not", () => {
    expect(isTransientRpcError(httpError(429))).toBe(true);
    expect(isTransientRpcError(httpError(503))).toBe(true);
    expect(isTransientRpcError(httpError(401))).toBe(false);
    expect(isTransientRpcError(revertError("UnknownRoot", [1n]))).toBe(false);
    expect(isTransientRpcError(rpcError(-32603, "VM Exception while processing transaction: reverted"))).toBe(false);
    expect(isTransientRpcError(new Error("fetch failed"))).toBe(true);
  });

  it("wraps any transport, not only the service's own", async () => {
    const fake = new FakeNode();
    fake.failNext(2, () => httpError(429));
    fake.head = 9n;
    const client = createPublicClient({ transport: retryingTransport(fake.transport(), { maxRetries: 2, baseDelayMs: 1 }) });

    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(9n);
  });
});

describe("waiting for a receipt", () => {
  it("waits for a receipt that is slow to arrive", async () => {
    node.advanceOnBlockNumber = true;
    node.pollsBeforeMined = 4;

    const published = await publishCredentialRoot(21n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);

    expect(published.blockNumber).toBe(node.sent[0]!.minedAt);
    expect(node.callsOf("eth_getTransactionReceipt").length).toBeGreaterThan(4);
  });

  it("waits for the configured confirmations", async () => {
    useNode({ confirmations: 3 });
    node.advanceOnBlockNumber = true;

    const published = await publishCredentialRoot(21n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    expect(node.head - published.blockNumber + 1n).toBeGreaterThanOrEqual(3n);
  });

  it("gives up after the receipt timeout, naming the transaction it sent", async () => {
    useNode({ receiptTimeoutMs: 150 });
    node.advanceOnBlockNumber = true;
    node.neverMine = true;

    const error = await publishCredentialRoot(21n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]).catch((cause) => cause);

    expect(error.output.statusCode).toBe(424);
    expect(error.output.payload.code).toBe("chain_receipt_timeout");
    expect(error.output.payload.details.txHash).toBe(node.sent[0]!.hash);
  });

  it("reads the replaced root from the receipt, not from a read of latest", async () => {
    node.credentialRoot = 5n;
    node.views.credentialRoot = () => 1n;

    const published = await publishCredentialRoot(6n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    expect(published.previousRoot).toBe(5n);
  });
});

describe("not trusting a lagging latest", () => {
  it("never answers from before the block of its own last confirmed write", async () => {
    const published = await publishCredentialRoot(31n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    node.reportedLag = 3n;

    expect(await stateBlock()).toBe(published.blockNumber);

    const at = await stateBlock();
    await readCredentialRoot({ at });
    expect(node.callsOf("eth_call").at(-1)!.params[1]).toBe(numberToHex(published.blockNumber));
  });

  it("estimates the invalidation at the block of the publication it follows", async () => {
    node.views.credentialRoot = () => 0n;
    const published = await publishCredentialRoot(41n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    node.reportedLag = 2n;

    await invalidateCredentialRoot(40n);
    const estimate = node.callsOf("eth_estimateGas").at(-1)!;
    expect(hexToBigInt(estimate.params[1] as Hex)).toBe(published.blockNumber);
  });

  it("keeps nonces moving when the node reports a stale transaction count", async () => {
    await publishCredentialRoot(51n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    node.staleNonce = true;
    await publishCredentialRoot(52n, [{ leafIndex: 1n, commitment: 8n, inserted: true }]);

    const nonces = node.sent.map((sent) => parseTransaction(sent.raw).nonce);
    expect(nonces).toEqual([0, 1]);
  });
});

describe("a write the node took, though the answer said otherwise", () => {
  /// Found by the stress run through a faulty proxy: in both cases the transaction was
  /// mined, the service answered a failure and rolled the database back, and the
  /// registry was left holding a leaf the issuer had no record of.
  it("waits for a receipt that lags behind its transaction instead of failing", async () => {
    node.advanceOnBlockNumber = true;
    node.receiptLagLookups = 3;

    const published = await publishCredentialRoot(81n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);

    expect(published.txHash).toBe(node.sent[0]!.hash);
    expect(published.blockNumber).toBe(node.sent[0]!.minedAt);
    expect(node.sent).toHaveLength(1);
  });

  it("takes a resend answered 'nonce too low' as sent when the node has that very transaction", async () => {
    node.knownTransactionError = "nonce too low";
    node.dropNextResponse("eth_sendRawTransaction");

    const published = await publishCredentialRoot(82n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);

    expect(node.sent).toHaveLength(1);
    expect(published.txHash).toBe(node.sent[0]!.hash);
    expect(node.callsOf("eth_sendRawTransaction")).toHaveLength(2);
  });

  it("retries the lookup that settles it, like any other read", async () => {
    node.knownTransactionError = "nonce too low";
    node.dropNextResponse("eth_sendRawTransaction");
    node.failNext(1, () => httpError(429), "eth_getTransactionByHash");

    const published = await publishCredentialRoot(84n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);

    expect(published.txHash).toBe(node.sent[0]!.hash);
    expect(node.sent).toHaveLength(1);
  });

  it("still fails a 'nonce too low' for a transaction the node never saw", async () => {
    node.failNext(1, () => httpError(502), "eth_sendRawTransaction");
    node.failNext(1, () => rpcError(-32000, "nonce too low"), "eth_sendRawTransaction");

    await expect(publishCredentialRoot(83n, [{ leafIndex: 0n, commitment: 9n, inserted: true }])).rejects.toMatchObject({
      output: { payload: { code: "chain_call_failed" } },
    });
    expect(node.sent).toHaveLength(0);
  });
});

describe("writes to different trees at the same time", () => {
  /// Each tree is changed under its own lock, so a credential publication and the
  /// jurisdiction updates of two assets can all be on their way at once. Found by the
  /// stress run: without sending in turn they took the same nonce and most failed.
  it("hands each concurrent write its own nonce", async () => {
    await Promise.all([
      publishCredentialRoot(61n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]),
      publishCountryRoot(1n, 62n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
      publishCountryRoot(2n, 63n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
      publishCountryRoot(3n, 64n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
    ]);

    const nonces = node.sent.map((sent) => parseTransaction(sent.raw).nonce).sort();
    expect(nonces).toEqual([0, 1, 2, 3]);
  });

  it("leaves no gap when one of them fails to send", async () => {
    node.failNext(1, () => httpError(400), "eth_sendRawTransaction");
    const outcomes = await Promise.allSettled([
      publishCountryRoot(1n, 72n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
      publishCountryRoot(2n, 73n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
      publishCountryRoot(3n, 74n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    await publishCountryRoot(4n, 75n, [{ leafIndex: 0n, countryCode: 170, admitted: true }]);
    const nonces = node.sent.map((sent) => parseTransaction(sent.raw).nonce).sort();
    expect(nonces).toEqual([0, 1, 2]);
  });
});

describe("reading the event log in windows", () => {
  async function seedLog(target: FakeNode) {
    target.head = 1_000n;
    const leaves: [bigint, bigint, boolean][] = [];
    for (let i = 0; i < 40; i++) leaves.push([BigInt(i % 12), BigInt(1_000 + i), i % 5 !== 4]);
    leaves.forEach(([leafIndex, commitment, inserted], i) => {
      target.addCredentialLeafLog(BigInt(3 + i * 23), i % 2, { newRoot: BigInt(i + 1), leafIndex, commitment, inserted });
    });
  }

  it("returns the same events whether the range is split or not", async () => {
    await seedLog(node);
    const whole = await fetchCredentialLeafEvents(0n, 1_000n, { blockRange: 1_000_000 });
    const split = await fetchCredentialLeafEvents(0n, 1_000n, { blockRange: 7 });

    expect(split).toEqual(whole);
    expect(whole).toHaveLength(40);
    expect(node.callsOf("eth_getLogs").length).toBe(1 + Math.ceil(1_001 / 7));
  });

  it("halves a window the node refuses and still gets every event", async () => {
    await seedLog(node);
    const whole = await fetchCredentialLeafEvents(0n, 1_000n, { blockRange: 1_000_000 });

    node.maxLogRange = 100n;
    const narrowed = await fetchCredentialLeafEvents(0n, 1_000n, { blockRange: 2_000 });

    expect(narrowed).toEqual(whole);
    const refused = node.callsOf("eth_getLogs").filter((call) => {
      const filter = call.params[0] as { fromBlock: Hex; toBlock: Hex };
      return hexToBigInt(filter.toBlock) - hexToBigInt(filter.fromBlock) + 1n > 100n;
    });
    expect(refused.length).toBeGreaterThan(1);
  });

  it("rebuilds the same tree from a split log as from a whole one", async () => {
    const hash = await poseidonHash();

    useNode({ logBlockRange: 1_000_000 });
    await seedLog(node);
    node.views.credentialRoot = () => 0n;
    const whole = await rebuildCredentialTreeFromChain();

    useNode({ logBlockRange: 13 });
    await seedLog(node);
    const split = await rebuildCredentialTreeFromChain();

    expect(split.report.replayedRoot).toBe(whole.report.replayedRoot);
    expect(split.report.events).toBe(40);
    expect(node.callsOf("eth_getLogs").length).toBeGreaterThan(70);

    const events = await fetchCredentialLeafEvents(0n, 1_000n);
    const replayed = replayLeafUpdates(
      CREDENTIAL_TREE_DEPTH,
      hash,
      events.map((event) => ({ leafIndex: event.leafIndex, value: event.commitment, present: event.inserted })),
    );
    expect(replayed.root().toString()).toBe(whole.report.replayedRoot);
  });

  it("reads the on-chain root at the block it replayed through", async () => {
    await seedLog(node);
    const { report } = await rebuildCredentialTreeFromChain();

    const rootRead = node.callsOf("eth_call").at(-1)!;
    expect(rootRead.params[1]).toBe(numberToHex(BigInt(report.throughBlock)));
  });
});

describe("finding a publication this service never recorded", () => {
  it("finds the transaction that made a root current, filtered by that root, in windows", async () => {
    useNode({ logBlockRange: 2 });
    const first = await publishCredentialRoot(6n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    await publishCredentialRoot(7n, [{ leafIndex: 1n, commitment: 10n, inserted: true }]);
    const calls = node.callsOf("eth_getLogs").length;

    const found = await findCredentialRootPublication(6n, 0n);

    expect(found).toEqual({ txHash: first.txHash, blockNumber: first.blockNumber, previousRoot: 0n });
    const queries = node.callsOf("eth_getLogs").slice(calls);
    expect(queries.length).toBeGreaterThan(1);
    expect((queries[0]!.params[0] as { topics: (Hex | null)[] }).topics[1]).toBe(numberToHex(6n, { size: 32 }));
  });

  it("finds nothing before the block it is told to search from", async () => {
    const first = await publishCredentialRoot(6n, [{ leafIndex: 0n, commitment: 9n, inserted: true }]);
    await publishCredentialRoot(7n, [{ leafIndex: 1n, commitment: 10n, inserted: true }]);

    expect(await findCredentialRootPublication(6n, first.blockNumber + 1n)).toBeNull();
    expect(await findCredentialRootPublication(8n, 0n)).toBeNull();
  });
});

describe("configuring the chain client", () => {
  function loadConfigWith(overrides: Record<string, string>) {
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config/index.ts')"], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, ...overrides },
      encoding: "utf8",
    });
  }

  it("validates every chain setting at startup", () => {
    const result = loadConfigWith({ CHAIN_CONFIRMATIONS: "0", CHAIN_LOG_BLOCK_RANGE: "wide", CHAIN_RPC_MAX_RETRIES: "-1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid_configuration");
    expect(result.stderr).toContain("CHAIN_CONFIRMATIONS");
    expect(result.stderr).toContain("CHAIN_LOG_BLOCK_RANGE");
    expect(result.stderr).toContain("CHAIN_RPC_MAX_RETRIES");
  });

  it("accepts the documented testnet values", () => {
    const result = loadConfigWith({ CHAIN_CONFIRMATIONS: "2", CHAIN_RECEIPT_TIMEOUT_MS: "120000", CHAIN_LOG_BLOCK_RANGE: "2000" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("holds every setting the client reads", () => {
    expect(config.chain).toMatchObject({
      confirmations: expect.any(Number),
      receiptTimeoutMs: expect.any(Number),
      pollingIntervalMs: expect.any(Number),
      rpcTimeoutMs: expect.any(Number),
      rpcMaxRetries: expect.any(Number),
      rpcRetryBaseMs: expect.any(Number),
      logBlockRange: expect.any(Number),
    });
  });
});
