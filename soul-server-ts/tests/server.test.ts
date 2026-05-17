import { describe, it, expect } from "vitest";
import pino from "pino";

import { buildServer } from "../src/server.js";

/**
 * fastify 5 회귀 차단 — `logger: pinoInstance`는 fastify 4 패턴이며 fastify 5는
 * `FST_ERR_LOG_INVALID_LOGGER_CONFIG`로 throw한다. pino 인스턴스는 `loggerInstance`
 * 별 키로 받아야 한다. 본 테스트가 부재하여 B-1 배포 시 runtime fatal 발생 → restart 무한 루프.
 *
 * 분석 캐시: 20260517-0500-phase-b1-hotfix-fastify5-env.md §4.1
 * fastify 타입 정본: node_modules/.pnpm/fastify@5.8.5/.../fastify.d.ts L128-129
 */
describe("buildServer (Phase B-1 hotfix F1 회귀 차단)", () => {
  it("pino 인스턴스 주입이 throw 없이 FastifyInstance를 반환한다", async () => {
    const logger = pino({ level: "silent" });

    const server = await buildServer({
      host: "127.0.0.1",
      port: 0, // 실제 bind 미수행 (inject로 검증)
      nodeId: "test-node",
      logger,
    });

    // 구조 단언만 (참조 동일성은 fastify가 child() 래핑할 수 있어 비보장 — spec-reviewer P2-1)
    expect(server).toBeDefined();
    expect(typeof server.inject).toBe("function");
    expect(server.log).toBeDefined();
    expect(typeof server.log.info).toBe("function");

    await server.close();
  });

  it("GET /health가 200 + 정합 payload 반환", async () => {
    const logger = pino({ level: "silent" });

    const server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger,
    });

    const res = await server.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      node_id: "test-node",
      service: "soul-server-ts",
      phase: "B-1",
    });

    await server.close();
  });
});
