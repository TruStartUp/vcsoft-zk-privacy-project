import Redis from "ioredis";

import { config } from "../config/index.js";

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = undefined;
}

/// Claims a nonce for the length of the replay window. Returns false when the
/// nonce was already used, which is what makes a captured signature single-use.
export async function claimNonce(partnerKey: string, nonce: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis().set(`nonce:${partnerKey}:${nonce}`, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}
