import { afterAll } from "vitest";

import { prisma } from "../src/lib/prisma.js";
import { closeRedis, redis } from "../src/lib/redis.js";

afterAll(async () => {
  await redis().flushdb();
  await closeRedis();
  await prisma.$disconnect();
});
