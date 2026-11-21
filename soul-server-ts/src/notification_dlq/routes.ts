/**
 * 노드 로컬 notification DLQ 조회·재큐 라우트.
 *
 * 세션 안에서 도는 CLI가 orch의 서비스 토큰 대신 로컬 soul-server를 부른다.
 * 인증은 MCP principal 판정을 재사용한다: 서비스 토큰과 full 세션 토큰(ssf1)만
 * 통과하고, restricted(ssr1)는 403, 토큰 없음·위조는 401이다. 실제 orch 호출은
 * 서버 자신의 자격(`SessionDeliveryNotificationHostClient`)으로 한다.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { SessionDeliveryNotificationHostClient } from "../control_plane/persistence_host_clients.js";
import {
  resolveMcpPrincipal,
} from "../mcp/auth.js";
import type { McpAuthConfig } from "@soulstream/mcp-contract";
import {
  extractBearerToken,
  isRestrictedMcpToken,
} from "../security/restricted_mcp_auth.js";

export const NOTIFICATION_DLQ_ROUTE_SEGMENT = "notification-dlq";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

export interface NotificationDlqRouteConfig {
  /** 라우트가 붙을 base path(내부 MCP 경로). 예: `/mcp/internal`. */
  basePath: string;
  /** 내부 MCP 라우트와 같은 인증 설정. */
  auth: McpAuthConfig;
  /** 서버 자신의 orch 자격으로 DLQ를 읽고 재큐하는 클라이언트. */
  notifications: Pick<
    SessionDeliveryNotificationHostClient,
    "listDeadLetters" | "requeueDeadLetter"
  >;
}

export function registerNotificationDlqRoutes(
  fastify: FastifyInstance,
  config: NotificationDlqRouteConfig,
): void {
  const base = config.basePath.replace(/\/+$/, "");
  const routeBase = `${base}/${NOTIFICATION_DLQ_ROUTE_SEGMENT}`;

  fastify.get(`${routeBase}/dead-letters`, async (request, reply) => {
    if (!(await authorize(request, reply, config.auth))) return reply;
    const limit = parseLimit(request.query);
    if (limit === undefined) {
      return reply.code(400).send({ error: "limit must be an integer between 1 and 1000" });
    }
    try {
      return { rows: await config.notifications.listDeadLetters(limit) };
    } catch {
      return reply.code(502).send({ error: "notification delivery host unavailable" });
    }
  });

  fastify.post(`${routeBase}/requeue`, async (request, reply) => {
    if (!(await authorize(request, reply, config.auth))) return reply;
    const deliveryId = readDeliveryId(request.body);
    if (!deliveryId) {
      return reply.code(400).send({ error: "deliveryId is required" });
    }
    try {
      return { row: await config.notifications.requeueDeadLetter(deliveryId) };
    } catch {
      return reply.code(502).send({ error: "notification delivery host unavailable" });
    }
  });
}

async function authorize(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: McpAuthConfig,
): Promise<boolean> {
  const authorization = typeof request.headers.authorization === "string"
    ? request.headers.authorization
    : undefined;
  const token = extractBearerToken(authorization);
  if (isRestrictedMcpToken(token)) {
    reply.code(403).send({ error: "restricted credentials are not accepted" });
    return false;
  }
  const resolution = await resolveMcpPrincipal(
    { ...auth, requireAuth: true },
    { host: request.headers.host, authorization },
  );
  if (!resolution.ok) {
    reply.code(resolution.status).send({ error: resolution.message });
    return false;
  }
  return true;
}

function parseLimit(query: unknown): number | undefined {
  const raw = isRecord(query) ? query.limit : undefined;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    return undefined;
  }
  return value;
}

function readDeliveryId(body: unknown): string | undefined {
  const raw = isRecord(body) ? body.deliveryId : undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
