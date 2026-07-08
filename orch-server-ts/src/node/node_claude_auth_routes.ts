import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type RequestResponseNodeCommandPayload,
} from "./pending_commands.js";
import type { InMemoryNodeRegistry, NodeConnectionSnapshot } from "./registry.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../session/session_command_transport.js";
import {
  BROWSER_SCOPE,
  CLAUDE_OAUTH_TOKEN_URL,
  HEADLESS_REDIRECT_URI,
  HEADLESS_SCOPE,
  ackErrorDetail,
  buildAuthorizeUrl,
  detail,
  forwardAuthHeaders,
  isUnsuccessfulAck,
  parseHeadlessCode,
  parseTokenData,
  redirect,
  responseText,
  setTokenPayload,
  stringQuery,
  type TokenData,
} from "./node_claude_auth_helpers.js";

export type ClaudeOAuthConfig = {
  clientId: string;
  callbackUrl: string;
};

export type NodeClaudeAuthRouteProvider = {
  getOAuthConfig: () => Promise<ClaudeOAuthConfig> | ClaudeOAuthConfig;
};

export type ClaudeAuthPkceProvider = {
  generateVerifier: () => string;
  generateChallenge: (verifier: string) => string;
  generateState: () => string;
};

export type ClaudeAuthSessionRecord = {
  verifier: string;
  metadata: Record<string, string | undefined>;
};

export type ClaudeAuthSessionStore = {
  create: (
    state: string,
    verifier: string,
    options: { metadata: Record<string, string | undefined> },
  ) => Promise<void> | void;
  pop: (state: string) => Promise<ClaudeAuthSessionRecord | undefined> | ClaudeAuthSessionRecord | undefined;
};

export type ClaudeAuthTokenExchangeRequest = {
  url: string;
  flow: "browser" | "headless";
  data: Record<string, string>;
};

export type ClaudeAuthTokenExchangeResponse = {
  statusCode: number;
  body?: unknown;
  text?: string;
};

export type ClaudeAuthTokenExchangeClient = (
  request: ClaudeAuthTokenExchangeRequest,
) => Promise<ClaudeAuthTokenExchangeResponse>;

export type NodeClaudeAuthHttpRequest = {
  method: "GET";
  url: string;
  path: string;
  headers: Record<string, string>;
  node: NodeConnectionSnapshot;
};

export type NodeClaudeAuthHttpResponse = {
  statusCode: number;
  body?: unknown;
};

export type NodeClaudeAuthHttpClient = (
  request: NodeClaudeAuthHttpRequest,
) => Promise<NodeClaudeAuthHttpResponse>;

export type NodeClaudeAuthRouteOptions = {
  provider: NodeClaudeAuthRouteProvider;
  pkce: ClaudeAuthPkceProvider;
  sessionStore: ClaudeAuthSessionStore;
  tokenExchange: ClaudeAuthTokenExchangeClient;
  profileHttpClient: NodeClaudeAuthHttpClient;
  registry: InMemoryNodeRegistry;
  bridge: SessionCommandTransportBridge;
  timeoutMs?: number;
};

type NodeParams = {
  node_id: string;
};

type CallbackQuery = {
  code?: string;
  state?: string;
};

const PROVIDERS = new Set(["claude", "codex", "gemini"]);

export const nodeClaudeAuthRouteAuthRequirements = {
  "GET /api/nodes/:node_id/claude-auth/start": true,
  "GET /api/nodes/claude-auth/callback": true,
  "GET /api/nodes/:node_id/claude-auth/status": true,
  "GET /api/nodes/:node_id/claude-auth/usage": true,
  "GET /api/nodes/:node_id/claude-auth/profile": true,
  "GET /api/nodes/:node_id/claude-auth/profiles": true,
  "DELETE /api/nodes/:node_id/claude-auth/token": true,
  "GET /api/nodes/:node_id/claude-auth/headless/start": true,
  "POST /api/nodes/:node_id/claude-auth/headless/submit-code": true,
  "GET /api/nodes/:node_id/provider-usage": true,
  "GET /api/nodes/:node_id/provider-usage/:provider": true,
} as const;

export function registerNodeClaudeAuthRoutes(
  app: FastifyInstance,
  options: NodeClaudeAuthRouteOptions,
): void {
  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/start",
    async (request, reply) => {
      const config = await options.provider.getOAuthConfig();
      const verifier = options.pkce.generateVerifier();
      const challenge = options.pkce.generateChallenge(verifier);
      const state = options.pkce.generateState();
      await options.sessionStore.create(state, verifier, {
        metadata: { node_id: nodeParams(request).node_id },
      });
      return redirect(reply, buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.callbackUrl,
        scope: BROWSER_SCOPE,
        state,
        challenge,
        codeMode: false,
      }));
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    "/api/nodes/claude-auth/callback",
    async (request, reply) => {
      const query = callbackQuery(request);
      const state = stringQuery(query.state);
      const code = stringQuery(query.code);
      if (state === undefined) {
        return detail(reply, 400, "Invalid or expired OAuth state");
      }
      const session = await options.sessionStore.pop(state);
      if (session === undefined) {
        return detail(reply, 400, "Invalid or expired OAuth state");
      }
      const nodeId = session.metadata.node_id;
      if (nodeId === undefined || nodeId.length === 0) {
        return detail(reply, 400, "Missing node_id in session");
      }
      if (options.registry.getConnectedNode(nodeId) === undefined) {
        return detail(reply, 404, `Node ${nodeId} not connected`);
      }
      if (code === undefined) return detail(reply, 400, "Missing code");

      const config = await options.provider.getOAuthConfig();
      const exchanged = await exchangeToken(reply, options, {
        flow: "browser",
        data: {
          grant_type: "authorization_code",
          client_id: config.clientId,
          code,
          redirect_uri: config.callbackUrl,
          code_verifier: session.verifier,
          state,
        },
      });
      if (!exchanged.ok) return exchanged.reply;

      const command = await dispatchNodeCommandResult(
        reply,
        options,
        nodeId,
        setTokenPayload(exchanged.token),
      );
      if (!command.ok) return command.reply;
      return redirect(reply, "/?claude_auth=success");
    },
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/status",
    async (request, reply) => sendRawCommand(reply, options, nodeParams(request).node_id, {
      type: "claude_auth_status",
    }),
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/usage",
    async (request, reply) => sendDataCommand(reply, options, nodeParams(request).node_id, {
      type: "claude_auth_get_usage",
    }),
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/profile",
    async (request, reply) => sendDataCommand(reply, options, nodeParams(request).node_id, {
      type: "claude_auth_get_profile",
    }),
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/profiles",
    async (request, reply) => {
      const nodeId = nodeParams(request).node_id;
      const node = options.registry.getConnectedNode(nodeId);
      if (node === undefined) return detail(reply, 404, `Node ${nodeId} not connected`);
      try {
        const response = await options.profileHttpClient({
          method: "GET",
          url: `http://${node.host}:${node.port}/auth/claude/profiles`,
          path: "/auth/claude/profiles",
          headers: forwardAuthHeaders(request),
          node,
        });
        if (response.statusCode !== 200) return reply.code(response.statusCode).send();
        return reply.send(response.body);
      } catch {
        return reply.code(502).send();
      }
    },
  );

  app.delete<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/token",
    async (request, reply) => sendRawCommand(reply, options, nodeParams(request).node_id, {
      type: "claude_auth_delete_token",
    }),
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/headless/start",
    async (request, reply) => {
      const nodeId = nodeParams(request).node_id;
      if (options.registry.getConnectedNode(nodeId) === undefined) {
        return detail(reply, 404, `Node ${nodeId} not connected`);
      }
      const config = await options.provider.getOAuthConfig();
      const verifier = options.pkce.generateVerifier();
      const challenge = options.pkce.generateChallenge(verifier);
      const state = options.pkce.generateState();
      await options.sessionStore.create(state, verifier, {
        metadata: { node_id: nodeId },
      });
      return reply.send({
        authUrl: buildAuthorizeUrl({
          clientId: config.clientId,
          redirectUri: HEADLESS_REDIRECT_URI,
          scope: HEADLESS_SCOPE,
          state,
          challenge,
          codeMode: true,
        }),
      });
    },
  );

  app.post<{ Params: NodeParams }>(
    "/api/nodes/:node_id/claude-auth/headless/submit-code",
    async (request, reply) => {
      const nodeId = nodeParams(request).node_id;
      const parsed = parseHeadlessCode(request.body);
      if (!parsed.ok) return detail(reply, 400, parsed.detail);
      const session = await options.sessionStore.pop(parsed.state);
      if (session === undefined) return detail(reply, 400, "invalid_state");
      if (session.metadata.node_id !== nodeId) return detail(reply, 400, "node_id mismatch");
      if (options.registry.getConnectedNode(nodeId) === undefined) {
        return detail(reply, 404, `Node ${nodeId} not connected`);
      }

      const config = await options.provider.getOAuthConfig();
      const exchanged = await exchangeToken(reply, options, {
        flow: "headless",
        data: {
          grant_type: "authorization_code",
          client_id: config.clientId,
          code: parsed.authorizationCode,
          redirect_uri: HEADLESS_REDIRECT_URI,
          code_verifier: session.verifier,
          state: parsed.state,
        },
      });
      if (!exchanged.ok) return exchanged.reply;

      const command = await dispatchNodeCommandResult(
        reply,
        options,
        nodeId,
        setTokenPayload(exchanged.token),
      );
      if (!command.ok) return command.reply;
      return reply.send({ success: true });
    },
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/provider-usage",
    async (request, reply) => sendDataCommand(reply, options, nodeParams(request).node_id, {
      type: "provider_usage_get",
    }),
  );

  app.get<{ Params: NodeParams & { provider: string } }>(
    "/api/nodes/:node_id/provider-usage/:provider",
    async (request, reply) => {
      const params = request.params;
      if (!PROVIDERS.has(params.provider)) {
        return detail(reply, 400, "provider must be one of: claude, codex, gemini");
      }
      return sendDataCommand(reply, options, params.node_id, {
        type: "provider_usage_get",
        provider: params.provider,
      });
    },
  );
}

type CommandResult =
  | { ok: true; response: NodeCommandResponse }
  | { ok: false; reply: FastifyReply };

async function sendRawCommand(
  reply: FastifyReply,
  options: NodeClaudeAuthRouteOptions,
  nodeId: string,
  payload: RequestResponseNodeCommandPayload,
): Promise<FastifyReply | NodeCommandResponse> {
  const result = await dispatchNodeCommandResult(reply, options, nodeId, payload);
  return result.ok ? result.response : result.reply;
}

async function sendDataCommand(
  reply: FastifyReply,
  options: NodeClaudeAuthRouteOptions,
  nodeId: string,
  payload: RequestResponseNodeCommandPayload,
): Promise<FastifyReply | unknown> {
  const result = await dispatchNodeCommandResult(reply, options, nodeId, payload);
  if (!result.ok) return result.reply;
  if (isUnsuccessfulAck(result.response)) {
    return detail(reply, 400, ackErrorDetail(result.response));
  }
  return reply.send(result.response.data);
}

async function dispatchNodeCommandResult(
  reply: FastifyReply,
  options: NodeClaudeAuthRouteOptions,
  nodeId: string,
  payload: RequestResponseNodeCommandPayload,
): Promise<CommandResult> {
  const node = options.registry.getConnectedNode(nodeId);
  if (node === undefined) {
    return { ok: false, reply: detail(reply, 404, `Node ${nodeId} not connected`) };
  }
  try {
    const command = options.registry.createCommand(nodeId, payload, {
      timeoutMs: options.timeoutMs,
    });
    const response = await options.bridge.sendPendingCommand({ node, command });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, reply: sendCommandError(reply, error) };
  }
}

function sendCommandError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PendingNodeCommandRejectedError) {
    const response = error.response;
    if (response !== undefined && isUnsuccessfulAck(response)) {
      return detail(reply, 400, ackErrorDetail(response));
    }
    return reply.code(503).send({ error: { code: "NODE_COMMAND_REJECTED", message: error.message } });
  }
  if (error instanceof PendingNodeCommandTimeoutError) {
    return reply.code(503).send({
      error: {
        code: "NODE_COMMAND_TIMEOUT",
        message: error.message,
        requestId: error.requestId,
      },
    });
  }
  if (error instanceof NodeCommandTransportError) {
    return reply.code(503).send({
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.nodeId,
        connectionId: error.connectionId,
      },
    });
  }
  return reply.code(500).send({
    error: {
      code: "NODE_CLAUDE_AUTH_ROUTE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

async function exchangeToken(
  reply: FastifyReply,
  options: NodeClaudeAuthRouteOptions,
  request: Omit<ClaudeAuthTokenExchangeRequest, "url">,
): Promise<{ ok: true; token: TokenData } | { ok: false; reply: FastifyReply }> {
  const response = await options.tokenExchange({
    url: CLAUDE_OAUTH_TOKEN_URL,
    ...request,
  });
  if (response.statusCode !== 200) {
    const prefix =
      request.flow === "headless" ? "token_exchange_failed" : "Token exchange failed";
    return { ok: false, reply: detail(reply, 400, `${prefix}: ${responseText(response)}`) };
  }
  const token = parseTokenData(response.body);
  if (token === undefined) {
    return { ok: false, reply: detail(reply, 400, "Token exchange failed: missing access_token") };
  }
  return { ok: true, token };
}

function callbackQuery(request: FastifyRequest): CallbackQuery {
  return request.query as CallbackQuery;
}

function nodeParams(request: FastifyRequest): NodeParams {
  return request.params as NodeParams;
}
