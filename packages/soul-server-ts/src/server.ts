import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";

export interface ServerParams {
  host: string;
  port: number;
  nodeId: string;
  logger: Logger;
}

/**
 * fastify HTTP 서버 빌드. 본 B-1은 단일 엔드포인트만:
 * - `GET /health` → 노드 헬스 응답 (Haniel `ready: port:4205` 점검용)
 *
 * 외부 API(create_session 등)는 *없음* — 모든 통신은 orch WS reverse 채널을 통해 이루어진다.
 */
export async function buildServer(params: ServerParams): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: params.logger,
    disableRequestLogging: false,
  });

  fastify.get("/health", async () => ({
    status: "ok",
    node_id: params.nodeId,
    service: "soul-server-ts",
    phase: "B-1",
  }));

  return fastify;
}

export async function startServer(server: FastifyInstance, host: string, port: number): Promise<void> {
  await server.listen({ host, port });
}
