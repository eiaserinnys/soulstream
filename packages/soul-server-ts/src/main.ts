import dotenv from "dotenv";
import { ZodError } from "zod";

import { parseEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { buildServer, startServer } from "./server.js";
import { UpstreamAdapter } from "./upstream/adapter.js";

// Haniel cwd는 ./services/soulstream — install.configs.soul-server-ts-env path와 정합.
dotenv.config({ path: ".env.soul-server-ts" });

async function main(): Promise<void> {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (err) {
    if (err instanceof ZodError) {
      // 명시 실패 (design-principles §4) — 사람이 읽을 수 있는 형태로 stderr.
      console.error("Environment validation failed:");
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error("Environment parse threw:", err);
    }
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);
  logger.info(
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      upstreamUrl: env.SOULSTREAM_UPSTREAM_URL,
      environment: env.ENVIRONMENT,
      host: env.HOST,
      port: env.PORT,
    },
    "soul-server-ts starting (B-1 skeleton)",
  );

  // HTTP 서버 시작 (Haniel ready 점검용)
  const server = await buildServer({
    host: env.HOST,
    port: env.PORT,
    nodeId: env.SOULSTREAM_NODE_ID,
    logger,
  });
  await startServer(server, env.HOST, env.PORT);
  logger.info({ host: env.HOST, port: env.PORT }, "HTTP /health listening");

  // WS reverse adapter — orch에 등록
  const adapter = new UpstreamAdapter(
    {
      url: env.SOULSTREAM_UPSTREAM_URL,
      nodeId: env.SOULSTREAM_NODE_ID,
      host: env.HOST,
      port: env.PORT,
      authBearerToken: env.AUTH_BEARER_TOKEN,
      userName: env.DASH_USER_NAME,
      isProduction: env.ENVIRONMENT === "production",
    },
    logger,
  );

  // 백그라운드 실행 — top-level에서 await 안 함 (재연결 무한 루프이므로)
  adapter.run().catch((err) => {
    logger.fatal({ err }, "Upstream adapter terminated unexpectedly");
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    await adapter.shutdown();
    await server.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
