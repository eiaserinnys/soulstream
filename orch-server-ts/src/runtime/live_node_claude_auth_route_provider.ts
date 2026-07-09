import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

import type {
  ClaudeAuthSessionRecord,
  ClaudeAuthSessionStore,
  ClaudeAuthPkceProvider,
  ClaudeAuthTokenExchangeClient,
  NodeClaudeAuthHttpClient,
  NodeClaudeAuthRouteProvider,
  NodeClaudeAuthRouteOptions,
} from "../node/node_claude_auth_routes.js";
import type {
  LiveConfigProviderBoundary,
  LiveNodeHttpClientBoundary,
} from "./live_provider_dependencies.js";
import {
  LiveConfigProviderError,
  type LiveConfigProviderFailure,
} from "./live_config_route_providers.js";

export type LiveNodeClaudeAuthNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type LiveNodeClaudeAuthConfigProvider = Pick<
  LiveConfigProviderBoundary,
  "requireConfig"
>;

export type CreateLiveNodeClaudeAuthRouteProviderOptions = {
  readonly nodeHttpClient: LiveNodeClaudeAuthNodeHttpClient;
  readonly configProvider: LiveNodeClaudeAuthConfigProvider;
  readonly tokenExchangeFetch?: LiveNodeClaudeAuthTokenExchangeFetch;
  readonly tokenExchangeTimeoutMs?: number;
};

export type CreateLiveNodeClaudeAuthProfileHttpClientOptions = {
  readonly nodeHttpClient: LiveNodeClaudeAuthNodeHttpClient;
};

export type CreateLiveNodeClaudeAuthOAuthConfigProviderOptions = {
  readonly configProvider: LiveNodeClaudeAuthConfigProvider;
};

export type LiveNodeClaudeAuthTokenExchangeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateLiveNodeClaudeAuthTokenExchangeClientOptions = {
  readonly fetch?: LiveNodeClaudeAuthTokenExchangeFetch;
  readonly timeoutMs?: number;
};

export type LiveNodeClaudeAuthRandomBytes = (size: number) => Uint8Array;

export type LiveNodeClaudeAuthSha256Digest = (verifier: string) => Uint8Array;

export type CreateLiveNodeClaudeAuthPkceProviderOptions = {
  readonly randomBytes?: LiveNodeClaudeAuthRandomBytes;
  readonly sha256?: LiveNodeClaudeAuthSha256Digest;
};

export type LiveNodeClaudeAuthSessionStoreClock = () => number;

export type CreateLiveNodeClaudeAuthSessionStoreOptions = {
  readonly nowMs?: LiveNodeClaudeAuthSessionStoreClock;
  readonly ttlMs?: number;
};

export type LiveNodeClaudeAuthRouteProviderBundle = {
  readonly nodeClaudeAuthRoutes: Pick<
    NodeClaudeAuthRouteOptions,
    "pkce" | "profileHttpClient" | "provider" | "sessionStore" | "tokenExchange"
  >;
};

const PKCE_RANDOM_BYTE_LENGTH = 32;
const DEFAULT_SESSION_TTL_MS = 300_000;
const DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

export function createLiveNodeClaudeAuthRouteProviders(
  options: CreateLiveNodeClaudeAuthRouteProviderOptions,
): LiveNodeClaudeAuthRouteProviderBundle {
  return {
    nodeClaudeAuthRoutes: {
      pkce: createLiveNodeClaudeAuthPkceProvider(),
      provider: createLiveNodeClaudeAuthOAuthConfigProvider(options),
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient(options),
      sessionStore: createLiveNodeClaudeAuthSessionStore(),
      tokenExchange: createLiveNodeClaudeAuthTokenExchangeClient({
        fetch: options.tokenExchangeFetch,
        timeoutMs: options.tokenExchangeTimeoutMs,
      }),
    },
  };
}

export function createLiveNodeClaudeAuthOAuthConfigProvider(
  options: CreateLiveNodeClaudeAuthOAuthConfigProviderOptions,
): NodeClaudeAuthRouteProvider {
  return {
    getOAuthConfig: async () => {
      const [clientId, callbackUrl] = await Promise.all([
        requireClaudeAuthString(options.configProvider, "claude_oauth_client_id"),
        requireClaudeAuthString(
          options.configProvider,
          "claude_oauth_callback_url",
        ),
      ]);
      return { clientId, callbackUrl };
    },
  };
}

export function createLiveNodeClaudeAuthProfileHttpClient(
  options: CreateLiveNodeClaudeAuthProfileHttpClientOptions,
): NodeClaudeAuthHttpClient {
  return async (request) => {
    const response = await options.nodeHttpClient.requestNode({
      nodeId: request.node.nodeId,
      method: request.method,
      path: request.path,
      headers: request.headers,
    });
    return {
      statusCode: response.statusCode,
      body: response.body,
    };
  };
}

export function createLiveNodeClaudeAuthTokenExchangeClient(
  options: CreateLiveNodeClaudeAuthTokenExchangeClientOptions = {},
): ClaudeAuthTokenExchangeClient {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for live Claude auth token exchange");
  }
  const timeoutMs = normalizeTokenExchangeTimeoutMs(options.timeoutMs);

  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(request.data),
        signal: controller.signal,
      });
      if (response.status !== 200) {
        return {
          statusCode: response.status,
          text: await response.text(),
        };
      }
      return {
        statusCode: response.status,
        body: await response.json(),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createLiveNodeClaudeAuthPkceProvider(
  options: CreateLiveNodeClaudeAuthPkceProviderOptions = {},
): ClaudeAuthPkceProvider {
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const sha256 = options.sha256 ?? defaultSha256;
  return {
    generateVerifier: () => base64UrlNoPadding(randomBytes(PKCE_RANDOM_BYTE_LENGTH)),
    generateChallenge: (verifier) => base64UrlNoPadding(sha256(verifier)),
    generateState: () => base64UrlNoPadding(randomBytes(PKCE_RANDOM_BYTE_LENGTH)),
  };
}

export function createLiveNodeClaudeAuthSessionStore(
  options: CreateLiveNodeClaudeAuthSessionStoreOptions = {},
): ClaudeAuthSessionStore {
  const nowMs = options.nowMs ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, StoredClaudeAuthSession>();

  return {
    create: (state, verifier, createOptions) => {
      const now = nowMs();
      sessions.set(state, {
        verifier,
        metadata: { ...createOptions.metadata },
        createdAtMs: now,
      });
      evictExpired(sessions, now, ttlMs);
    },
    pop: (state) => {
      const session = sessions.get(state);
      sessions.delete(state);
      if (session === undefined || isExpired(session, nowMs(), ttlMs)) {
        return undefined;
      }
      return {
        verifier: session.verifier,
        metadata: { ...session.metadata },
      };
    },
  };
}

function defaultSha256(verifier: string): Uint8Array {
  return createHash("sha256").update(verifier, "ascii").digest();
}

function base64UrlNoPadding(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

type StoredClaudeAuthSession = ClaudeAuthSessionRecord & {
  readonly createdAtMs: number;
};

function evictExpired(
  sessions: Map<string, StoredClaudeAuthSession>,
  nowMs: number,
  ttlMs: number,
): void {
  for (const [state, session] of sessions.entries()) {
    if (isExpired(session, nowMs, ttlMs)) {
      sessions.delete(state);
    }
  }
}

function isExpired(
  session: StoredClaudeAuthSession,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - session.createdAtMs > ttlMs;
}

async function requireClaudeAuthString(
  configProvider: LiveNodeClaudeAuthConfigProvider,
  key: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await configProvider.requireConfig(key);
  } catch {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "missing", "string", undefined),
    ]);
  }
  if (value === undefined || value === null) {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "missing", "string", value),
    ]);
  }
  if (typeof value !== "string") {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "invalid_type", "string", value),
    ]);
  }
  return value;
}

function claudeAuthConfigFailure(
  key: string,
  reason: LiveConfigProviderFailure["reason"],
  expected: string,
  actual: unknown,
): LiveConfigProviderFailure {
  return {
    owner: "node.claude-auth",
    path: "nodeClaudeAuthRoutes.provider",
    key,
    reason,
    expected,
    actualType: actualType(actual),
  };
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeTokenExchangeTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(
      `Claude auth token exchange timeoutMs must be a positive integer: ${resolved}`,
    );
  }
  return resolved;
}
