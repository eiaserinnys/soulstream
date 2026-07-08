import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  NodeCommandResponse,
  RequestResponseNodeCommandPayload,
} from "./pending_commands.js";

export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const BROWSER_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const HEADLESS_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const HEADLESS_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";

export type TokenData = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: unknown;
  scope?: string;
};

export function buildAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  codeMode: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: input.scope,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  if (input.codeMode) params.set("code", "true");
  return `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export function setTokenPayload(
  token: TokenData,
): RequestResponseNodeCommandPayload<"claude_auth_set_token"> {
  return {
    type: "claude_auth_set_token",
    token: token.accessToken,
    ...(token.refreshToken !== undefined ? { refresh_token: token.refreshToken } : {}),
    ...(token.expiresIn !== undefined ? { expires_in: token.expiresIn } : {}),
    ...(token.scope !== undefined ? { scope: token.scope } : {}),
  };
}

export function parseTokenData(body: unknown): TokenData | undefined {
  if (!isRecord(body) || typeof body.access_token !== "string") return undefined;
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in !== undefined ? { expiresIn: body.expires_in } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

export function parseHeadlessCode(
  body: unknown,
): { ok: true; authorizationCode: string; state: string } | { ok: false; detail: string } {
  if (!isRecord(body) || typeof body.code !== "string") return { ok: false, detail: "missing_code" };
  const raw = body.code.trim();
  if (raw.length === 0) return { ok: false, detail: "missing_code" };
  const hashIndex = raw.indexOf("#");
  if (hashIndex === -1) return { ok: false, detail: "invalid_code_format" };
  return {
    ok: true,
    authorizationCode: raw.slice(0, hashIndex),
    state: raw.slice(hashIndex + 1),
  };
}

export function forwardAuthHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = firstHeader(request.headers.authorization);
  if (authorization !== undefined) headers.authorization = authorization;
  const cookie = firstHeader(request.headers.cookie);
  if (cookie !== undefined) headers.cookie = cookie;
  return headers;
}

export function redirect(reply: FastifyReply, url: string): FastifyReply {
  return reply.code(302).header("Location", url).send();
}

export function detail(
  reply: FastifyReply,
  statusCode: number,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ detail: message });
}

export function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function responseText(response: { text?: string; body?: unknown }): string {
  if (response.text !== undefined) return response.text;
  if (typeof response.body === "string") return response.body;
  return JSON.stringify(response.body ?? "");
}

export function isUnsuccessfulAck(response: NodeCommandResponse): boolean {
  return response.success === false || response.status === "error";
}

export function ackErrorDetail(response: NodeCommandResponse): string {
  if (typeof response.error === "string") return response.error;
  if (typeof response.message === "string") return response.message;
  return "unknown";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
