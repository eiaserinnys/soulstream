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
  requestContextForPrincipal,
  SOULSTREAM_AGENT_SESSION_HEADER,
  withMcpRequestContext,
  type McpRequestContext,
} from "./request_context.js";
import type { McpRuntime } from "./runtime.js";
import { buildMcpServer } from "./server.js";
import {
  SessionAgentIdCache,
  disallowedSoulstreamTools,
  findSessionAgentProfile,
  logMissingSessionProfile,
  type SessionProfileLookupOptions,
} from "./session_profile_tools.js";
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
  // 세션의 agent_id는 바뀌지 않으므로 프로세스 안에서 기억한다. 프로필 내용은
  // 매번 registry에서 꺼내므로 프로필 수정은 다음 요청에 그대로 반영된다.
  const profileLookup: SessionProfileLookupOptions = {
    cache: new SessionAgentIdCache(),
    ...(runtime.sessionProfileLookupSleep ? { sleep: runtime.sessionProfileLookupSleep } : {}),
  };

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
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const agentSessionId = requestContext(resolution.principal, req).callerSessionId;
    req.log.info({
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(typeof body?.method === "string" ? { method: body.method } : {}),
      ...(typeof body?.params?.name === "string" ? { toolName: body.params.name } : {}),
    }, "MCP request");
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
          profileLookup,
        );
      } else {
        await dispatchPost(req, reply, sessions, runtime, resolution, profileLookup);
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
  profileLookup: SessionProfileLookupOptions,
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
      // tools/call은 프로필 조회를 처리기 직전까지 미룬다. 조회 실패가 이 요청의
      // 도구 실행만 닫고, 같은 요청의 다른 처리(초기화·목록)는 막지 않게 한다.
      const server = buildMcpServer(runtime, await toolAccess(runtime, resolution, profileLookup, {
        deferProfileToCall: isToolsCallRequest(req.body),
      }));
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
  profileLookup: SessionProfileLookupOptions,
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
        const server = buildMcpServer(runtime, await toolAccess(runtime, resolution, profileLookup));
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
  return requestContextForPrincipal(
    principal,
    headerValue(req.headers[SOULSTREAM_AGENT_SESSION_HEADER]),
  );
}

/**
 * 서버 쪽 도구 거름. 세션 ID가 있는 principal(ssf1/ssr1)은 그 세션 에이전트
 * 프로필의 금지 도구를 restricted 정책과 같은 방식으로 끈다. 서비스 토큰처럼
 * 세션 ID가 없는 요청은 지금처럼 전체 도구다.
 *
 * 프로필이 없으면 지금처럼 거르지 않고 까닭을 남긴다. 조회가 실패하면 짧게 다시
 * 시도한 뒤, 세션 ID가 있는 모든 세션 토큰(full·restricted)의 그 요청 tools/call만
 * 닫는 조회기를 붙인다. restricted는 기존 격리 정책 거름도 그대로 함께 건다.
 */
async function toolAccess(
  runtime: McpRuntime,
  resolution: AuthenticatedResolution,
  profileLookup: SessionProfileLookupOptions,
  options: { deferProfileToCall?: boolean } = {},
): Promise<McpToolAccess | undefined> {
  const principal = resolution.principal;
  const policy = principal.tier === "restricted" ? resolution.policy : undefined;
  if (principal.tier === "restricted" && !policy) {
    throw new Error("restricted principal without isolation policy");
  }
  const sessionId = principal.sessionId;
  if (!sessionId) {
    return policy ? { principal, policy } : undefined;
  }

  const profileCall = {
    sessionId,
    resolve: () => findSessionAgentProfile(runtime, sessionId, profileLookup),
  };

  // stateless tools/call은 처리기 직전에 한 번만 조회한다. 조회 실패가 이 요청의
  // 도구 실행만 닫고, 나머지 처리와 추가 지연(1초 안쪽)을 늘리지 않는다.
  if (options.deferProfileToCall) {
    return { principal, ...(policy ? { policy } : {}), profileCall };
  }

  const lookup = await findSessionAgentProfile(runtime, sessionId, profileLookup);
  if (lookup.status === "found") {
    const disallowedTools = disallowedSoulstreamTools(lookup.profile);
    if (!policy && disallowedTools.size === 0) return undefined;
    return {
      principal,
      ...(policy ? { policy } : {}),
      ...(disallowedTools.size > 0 ? { disallowedTools } : {}),
    };
  }
  if (lookup.status === "missing") {
    logMissingSessionProfile(runtime.logger, sessionId, lookup.reason);
    return policy ? { principal, policy } : undefined;
  }

  runtime.logger.warn(
    { sessionId, reason: lookup.reason, attempts: lookup.attempts },
    "MCP session agent profile lookup failed",
  );
  // 세션 ID가 있는 모든 세션 토큰(full·restricted)은 조회 실패 때 그 요청의
  // tools/call만 닫는다. restricted도 기존 격리 정책 거름은 그대로 걸어,
  // #1955가 ssr1에 더한 프로필 거름이 같은 몇 초 동안 다시 비지 않게 한다.
  return { principal, ...(policy ? { policy } : {}), profileCall };
}

/**
 * 요청 본문(또는 batch)이 전부 tools/call인지. 섞인 batch는 지금처럼 서버를 만들 때
 * 프로필을 조회해 목록 거름을 잃지 않게 한다(조회 실패면 처리기 거름이 닫는다).
 */
function isToolsCallRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every((entry) => isToolsCallRequest(entry));
  }
  return typeof body === "object"
    && body !== null
    && (body as { method?: unknown }).method === "tools/call";
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
