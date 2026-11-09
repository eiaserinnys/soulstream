/**
 * MCP Streamable HTTP transport — Fastify 라우트 + stateful/stateless mode.
 *
 * SDK는 Node `IncomingMessage`/`ServerResponse`에 직접 쓰므로 Fastify v5의 `reply.hijack()`로
 * 자동 응답을 끄고 raw 객체를 위임한다. POST/GET/DELETE 모두 config.path에 등록된다.
 *
 * Lifecycle (stateful):
 *   - POST + body가 initialize 요청 + Mcp-Session-Id 없음 → 새 transport 생성, sessionIdGenerator
 *     발급, onsessioninitialized 콜백에서 transport map에 보관.
 *   - POST + 기존 Mcp-Session-Id → 매핑된 transport.handleRequest.
 *   - POST + Mcp-Session-Id 없음 + initialize 아님 → 400.
 *   - POST + 모르는 Mcp-Session-Id → 404.
 *   - GET + Mcp-Session-Id → SSE 스트림 시작. 없음 → 400. 모름 → 404.
 *   - DELETE + Mcp-Session-Id → 세션 종료. 없음 → 400. 모름 → 404.
 *
 * 모든 요청은 매번 인증 계층을 지나 principal(full | restricted session)을 판정하고,
 * stateful 세션은 최초 principal과 같은 요청만 받는다. restricted 요청은 그 세션의
 * 도구 정책과 함께 McpServer를 만든다.
 */
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  resolveMcpPrincipal,
  type McpAuthConfig,
  type McpRestrictedAuthConfig,
  type McpPrincipalResolution,
} from "./auth.js";
import {
  SOULSTREAM_AGENT_SESSION_HEADER,
  withMcpRequestContext,
  type McpRequestContext,
} from "./request_context.js";
import type { McpRuntime } from "./runtime.js";
import { buildMcpServer } from "./server.js";
import type { McpToolAccess } from "./tool_access.js";
import type { McpPrincipal } from "../security/session_isolation_contract.js";

export interface McpRouteConfig {
  path: string;
  auth: McpAuthConfig;
  statelessTransport: boolean;
  /** 없으면 restricted 자격 증명을 받지 않는다(MCP_REQUIRE_AUTH=false 포함). */
  restricted?: McpRestrictedAuthConfig;
}

type AuthenticatedResolution = Extract<McpPrincipalResolution, { ok: true }>;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  principal: McpPrincipal;
}

interface StatelessEntry {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof buildMcpServer>;
  closePromise?: Promise<void>;
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
  const statelessEntries = new Set<StatelessEntry>();

  const path = config.path;
  const authenticate = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedResolution | undefined> => {
    const headers = {
      host: typeof req.headers.host === "string" ? req.headers.host : undefined,
      authorization:
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : undefined,
    };
    const resolution = await resolveMcpPrincipal(config.auth, headers, config.restricted);
    if (!resolution.ok) {
      reply.code(resolution.status).send({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: resolution.message,
        },
        id: null,
      });
      return undefined;
    }
    return resolution;
  };

  fastify.post(path, async (req, reply) => {
    const resolution = await authenticate(req, reply);
    if (!resolution) return;
    reply.hijack();
    try {
      if (config.statelessTransport) {
        await dispatchStatelessPost(
          req,
          reply,
          statelessEntries,
          runtime,
          resolution,
        );
      } else {
        await dispatchPost(req, reply, sessions, runtime, resolution);
      }
    } catch (err) {
      runtime.logger.error(
        { err },
        "MCP POST dispatch threw — already hijacked, attempting raw write",
      );
      writeJsonRpcError(reply, 500, "internal error");
    }
  });

  fastify.get(path, async (req, reply) => {
    const resolution = await authenticate(req, reply);
    if (!resolution) return;
    reply.hijack();
    try {
      if (config.statelessTransport) {
        writeJsonRpcError(reply, 405, "method not allowed in stateless mode");
      } else {
        await dispatchGet(req, reply, sessions, resolution);
      }
    } catch (err) {
      runtime.logger.error({ err }, "MCP GET dispatch threw");
      writeJsonRpcError(reply, 500, "internal error");
    }
  });

  fastify.delete(path, async (req, reply) => {
    const resolution = await authenticate(req, reply);
    if (!resolution) return;
    reply.hijack();
    try {
      if (config.statelessTransport) {
        writeJsonRpcError(reply, 405, "method not allowed in stateless mode");
      } else {
        await dispatchDelete(req, reply, sessions, resolution);
      }
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
    await Promise.all(
      [...statelessEntries].map((entry) => closeStatelessEntry(
        statelessEntries,
        entry,
      )),
    );
  };
}

async function dispatchStatelessPost(
  req: FastifyRequest,
  reply: FastifyReply,
  active: Set<StatelessEntry>,
  runtime: McpRuntime,
  resolution: AuthenticatedResolution,
): Promise<void> {
  await withMcpRequestContext(
    requestContext(resolution.principal, req),
    async () => {

      // SDK official stateless mode: a fresh transport and McpServer per POST.
      // No MCP session ID is generated or validated, so server replacement cannot
      // strand a client on a process-local transport map.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = buildMcpServer(runtime, toolAccess(resolution));
      const entry: StatelessEntry = { transport, server };
      active.add(entry);
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await closeStatelessEntry(active, entry);
      };
      reply.raw.once("close", () => {
        void close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        await close();
        throw err;
      }
    },
  );
}

async function closeStatelessEntry(
  active: Set<StatelessEntry>,
  entry: StatelessEntry,
): Promise<void> {
  if (entry.closePromise) return entry.closePromise;
  entry.closePromise = (async () => {
    await Promise.allSettled([
      entry.transport.close(),
      entry.server.close(),
    ]);
    active.delete(entry);
  })();
  return entry.closePromise;
}

async function dispatchPost(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
  runtime: McpRuntime,
  resolution: AuthenticatedResolution,
): Promise<void> {
  const sessionId = headerValue(req.headers["mcp-session-id"]);
  const body = req.body;

  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!;
    if (!samePrincipal(entry.principal, resolution.principal)) {
      writeJsonRpcError(reply, 403, "principal mismatch");
      return;
    }
    await withMcpRequestContext(
      requestContext(resolution.principal, req),
      async () => {
        await entry.transport.handleRequest(req.raw, reply.raw, body);
      },
    );
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId: string) => {
        sessions.set(newId, { transport, principal: resolution.principal });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
    };
    await withMcpRequestContext(
      requestContext(resolution.principal, req),
      async () => {
        const server = buildMcpServer(runtime, toolAccess(resolution));
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, body);
      },
    );
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
  resolution: AuthenticatedResolution,
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
  if (!samePrincipal(entry.principal, resolution.principal)) {
    writeJsonRpcError(reply, 403, "principal mismatch");
    return;
  }
  await withMcpRequestContext(
    requestContext(resolution.principal, req),
    async () => {
      await entry.transport.handleRequest(req.raw, reply.raw);
    },
  );
}

async function dispatchDelete(
  req: FastifyRequest,
  reply: FastifyReply,
  sessions: Map<string, SessionEntry>,
  resolution: AuthenticatedResolution,
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
  if (!samePrincipal(entry.principal, resolution.principal)) {
    writeJsonRpcError(reply, 403, "principal mismatch");
    return;
  }
  await withMcpRequestContext(
    requestContext(resolution.principal, req),
    async () => {
      await entry.transport.handleRequest(req.raw, reply.raw);
    },
  );
}

function requestContext(principal: McpPrincipal, req: FastifyRequest): McpRequestContext {
  if (principal.tier === "restricted") {
    return { principal, callerSessionId: principal.sessionId };
  }
  return {
    principal,
    callerSessionId: headerValue(req.headers[SOULSTREAM_AGENT_SESSION_HEADER]),
  };
}

function toolAccess(resolution: AuthenticatedResolution): McpToolAccess | undefined {
  if (resolution.principal.tier !== "restricted") return undefined;
  if (!resolution.policy) {
    throw new Error("restricted principal without isolation policy");
  }
  return { principal: resolution.principal, policy: resolution.policy };
}

function samePrincipal(left: McpPrincipal, right: McpPrincipal): boolean {
  if (left.tier !== right.tier) return false;
  if (left.tier === "full" || right.tier === "full") return true;
  return left.sessionId === right.sessionId;
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
