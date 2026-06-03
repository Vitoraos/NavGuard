// src/config/redis.ts
// Single shared ioredis client. Import this everywhere — never new Redis() elsewhere.
// REDIS_URL must be set in .env for production (Upstash or Redis Cloud TLS URL).

import Redis from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is required");
}

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("connect",   () => console.log("[redis] Connected"));
redis.on("error",     (err) => console.error("[redis] Error:", err));
redis.on("reconnecting", () => console.log("[redis] Reconnecting..."));

// Subscriber client — ioredis requires a dedicated connection for subscribe mode
export const redisSub = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});
