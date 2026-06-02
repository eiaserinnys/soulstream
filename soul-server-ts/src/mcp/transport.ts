/**
 * MCP Streamable HTTP transport — Fastify 라우트 + 세션 transport map.
 *
 * SDK는 Node `IncomingMessage`/`ServerResponse`에 직접 쓰므로 Fastify v5의 `reply.hijack()`로
 * 자동 응답을 끄고 raw 객체를 위임한다. POST/GET/DELETE 모두 같은 경로(env.MCP_PATH).
 *
 * Lifecycle (stateful):
 *   - POST + body가 initialize 요청 + Mcp-Session-Id 없음 → 새 transport 생성, sessionIdGenerator
 *     발급, onsessioninitialized 콜백에서 transport map에 보관.
 *   - POST + 기존 Mcp-Session-Id → 매핑된 transport.handleRequest.
 *   - POST + Mcp-Session-Id 없음 + initialize 아님 → 400.
 *   - POST + 모르는 Mcp-Session-Id → 404.
 *   - GET + Mcp-Session-Id → SSE 스트림 시작. 없음 → 400. 모름 → 404.
 *   - DELETE + Mcp-Session-Id → 세션 종료. 없음 → 400. 모름 → 404.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { checkMcpAuth, type McpAuthConfig } from "./auth.js";
import {
  SOULSTREAM_AGENT_SESSION_HEADER,
  withMcpRequestContext,
} from "./request_context.js";
import type { McpRuntime } from "./runtime.js";
import { buildMcpServer } from "./server.js";

export interface McpRouteConfig {
  path: string;
  auth: McpAuthConfig;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
}

/**
 * Fastify 라우트 등록. 본 함수가 반환하는 cleanup 함수는 서버 종료 시 호출하여
 * 모든 transport를 닫는다 (graceful shutdown).
 */
export function registerMcpRoutes(
  fastify: FastifyInstance,
  runtime: McpRuntime,
  config: McpRouteConfig,
): () => Promise<void> {
  const sessions = new Map<string, SessionEntry>();

  const path = config.path;
  const guard = (
    req: FastifyRequest,
    reply: FastifyReply,
  ): { ok: true } | { ok: false } => {
    const headers = {
      host: typeof req.headers.host === "string" ? req.headers.host : undefined,
      authorization:
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : undefined,
    };
    const check = checkMcpAuth(config.auth, headers);
    if (!check.ok) {
      reply.code(check.status ?? 401).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: check.message ?? "unauthorized",
        },
        id: null,
      });
      return { ok: false };
    }
    return { ok: true };
  };

  fastify.post(path, async (req, reply) => {
    if (!guard(req, reply).ok) return;
    reply.hijack();
    try {
      await dispatchPost(req, reply, sessions, runtime);
    } catch (err) {
      runtime.logger.error(
        { err },
        "MCP POST dispatch threw — already hijacked, attempting raw write",
      );
      writeJsonRpcError(reply, 500, "internal error");
    }
  });

  fastify.get(path, async (req, reply) => {
    if (!guard(req, reply).ok) return;
    reply.hijack();
    try {
      await dispatchGet(req, reply, sessions);
    } catch (err) {
      runtime.logger.error({ err }, "MCP GET dispatch threw");
      writeJsonRpcError(reply, 500, "internal error");
    }
  });

  fastify.delete(path, async (req, reply) => {
    if (!guard(req, reply).ok) return;
    reply.hijack();
    try {
      await dispatchDelete(req, reply, sessions);
    } catch (err) {
      runtime.logger.error({ err }, "MCP DELETE dispatch threw");
      writeJsonRpcError(reply, 500, "internal error");
    }
  });

  // graceful shutdown closure
  return async () => {
    for (const [id, entry] of sessions) {
      try {
        await entry.transport.close();
      } catch {
        // ignore
      }
      sessions.delete(id);
    }
  };
}

async function dispatchPost(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
  runtime: McpRuntime,
): Promise<void> {
  return withMcpRequestContext(
    {
      callerSessionId: headerValue(req.headers[SOULSTREAM_AGENT_SESSION_HEADER]),
    },
    async () => dispatchPostWithContext(req, reply, sessions, runtime),
  );
}

async function dispatchPostWithContext(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
  runtime: McpRuntime,
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  const body = req.body;

  if (sessionId && sessions.has(sessionId)) {
    // 기존 세션 — 그대로 위임
    const entry = sessions.get(sessionId)!;
    await entry.transport.handleRequest(req.raw, reply.raw, body);
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    // 새 세션 생성 — onsessioninitialized에서 map에 박는다
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId: string) => {
        sessions.set(newId, { transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };
    const server = buildMcpServer(runtime);
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, body);
    return;
  }

  if (sessionId && !sessions.has(sessionId)) {
    writeJsonRpcError(reply, 404, `unknown session: ${sessionId}`);
    return;
  }

  writeJsonRpcError(reply, 400, "missing session id and not an initialize request");
}

async function dispatchGet(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (!sessionId) {
    writeJsonRpcError(reply, 400, "missing session id");
    return;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    writeJsonRpcError(reply, 404, `unknown session: ${sessionId}`);
    return;
  }
  await entry.transport.handleRequest(req.raw, reply.raw);
}

async function dispatchDelete(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  if (!sessionId) {
    writeJsonRpcError(reply, 400, "missing session id");
    return;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    writeJsonRpcError(reply, 404, `unknown session: ${sessionId}`);
    return;
  }
  await entry.transport.handleRequest(req.raw, reply.raw);
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return h;
}

function writeJsonRpcError(
  reply: FastifyReply,
  status: number,
  message: string,
): void {
  const raw = reply.raw;
  if (raw.headersSent) return;
  raw.statusCode = status;
  raw.setHeader("content-type", "application/json");
  raw.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}
