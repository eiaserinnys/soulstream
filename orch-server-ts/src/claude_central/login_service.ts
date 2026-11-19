import { createHash, randomBytes } from "node:crypto";

import {
  CLAUDE_OAUTH_TOKEN_URL,
  HEADLESS_REDIRECT_URI,
  HEADLESS_SCOPE,
  buildAuthorizeUrl,
  parseTokenData,
} from "../node/node_claude_auth_helpers.js";

import type { ClaudeCentralAccountRepository } from "./account_repository.js";
import type { ClaudeCentralAccountRecord } from "./types.js";

export const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClaudeCentralLoginState =
  | "url_ready"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export type ClaudeCentralLoginSnapshot = {
  readonly login_id: string;
  readonly account_id: string | null;
  readonly state: ClaudeCentralLoginState;
  readonly auth_url: string;
  readonly expires_at: string;
  readonly error: { readonly code: string; readonly message: string } | null;
};

export type ClaudeCentralTokenExchangeRequest = {
  readonly url: string;
  readonly data: Record<string, string>;
};

export type ClaudeCentralTokenExchangeResponse = {
  readonly statusCode: number;
  readonly body?: unknown;
  readonly text?: string;
};

export type ClaudeCentralTokenExchange = (
  request: ClaudeCentralTokenExchangeRequest,
) => Promise<ClaudeCentralTokenExchangeResponse>;

export type ClaudeCentralProfileFetcher = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export type ClaudeCentralPkceProvider = {
  readonly generateVerifier: () => string;
  readonly generateChallenge: (verifier: string) => string;
  readonly generateState: () => string;
};

export type ClaudeCentralLoginServiceOptions = {
  readonly repository: ClaudeCentralAccountRepository;
  readonly clientId: () => Promise<string> | string;
  readonly pkce?: ClaudeCentralPkceProvider;
  readonly tokenExchange?: ClaudeCentralTokenExchange;
  readonly fetchProfile?: ClaudeCentralProfileFetcher;
  readonly now?: () => number;
  readonly loginTtlMs?: number;
  readonly onAccountLoggedIn?: (account: ClaudeCentralAccountRecord) => void;
};

export class ClaudeCentralLoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ClaudeCentralLoginError";
  }
}

type LoginFlow = {
  readonly loginId: string;
  accountId: string | null;
  state: ClaudeCentralLoginState;
  readonly authUrl: string;
  readonly stateParam: string;
  readonly verifier: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  error: { code: string; message: string } | null;
};

export class ClaudeCentralLoginService {
  private readonly repository: ClaudeCentralAccountRepository;
  private readonly clientId: () => Promise<string> | string;
  private readonly pkce: ClaudeCentralPkceProvider;
  private readonly tokenExchange: ClaudeCentralTokenExchange;
  private readonly fetchProfile: ClaudeCentralProfileFetcher;
  private readonly now: () => number;
  private readonly loginTtlMs: number;
  private readonly onAccountLoggedIn?: (account: ClaudeCentralAccountRecord) => void;
  private readonly flows = new Map<string, LoginFlow>();

  constructor(options: ClaudeCentralLoginServiceOptions) {
    this.repository = options.repository;
    this.clientId = options.clientId;
    this.pkce = options.pkce ?? createNodePkceProvider();
    this.tokenExchange = options.tokenExchange ?? defaultTokenExchange;
    this.fetchProfile = options.fetchProfile ?? defaultProfileFetcher;
    this.now = options.now ?? Date.now;
    this.loginTtlMs = options.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.onAccountLoggedIn = options.onAccountLoggedIn;
  }

  async start(input: { account_id?: string } = {}): Promise<ClaudeCentralLoginSnapshot> {
    if (input.account_id !== undefined) {
      const existing = await this.repository.findById(input.account_id);
      if (existing === null) {
        throw new ClaudeCentralLoginError(
          "account_not_found",
          "Claude 계정을 찾을 수 없습니다.",
          404,
        );
      }
    }

    // 새 로그인이 이전 로그인 창을 대체한다(노드 풀 로그인과 같은 동작).
    for (const flow of this.flows.values()) {
      if (flow.state === "url_ready" || flow.state === "verifying") {
        flow.state = "cancelled";
      }
    }

    const clientId = await this.clientId();
    const verifier = this.pkce.generateVerifier();
    const challenge = this.pkce.generateChallenge(verifier);
    const stateParam = this.pkce.generateState();
    const nowMs = this.now();
    const loginId = crypto.randomUUID();
    const flow: LoginFlow = {
      loginId,
      accountId: input.account_id ?? null,
      state: "url_ready",
      authUrl: buildAuthorizeUrl({
        clientId,
        redirectUri: HEADLESS_REDIRECT_URI,
        scope: HEADLESS_SCOPE,
        state: stateParam,
        challenge,
        codeMode: true,
      }),
      stateParam,
      verifier,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.loginTtlMs,
      error: null,
    };
    this.flows.set(loginId, flow);
    return snapshot(flow);
  }

  status(loginId: string): ClaudeCentralLoginSnapshot {
    return snapshot(this.requireFlow(loginId));
  }

  async submitCode(loginId: string, rawCode: string): Promise<ClaudeCentralLoginSnapshot> {
    const flow = this.requireFlow(loginId);
    if (isTerminal(flow.state)) return snapshot(flow);
    if (flow.state !== "url_ready") {
      throw new ClaudeCentralLoginError(
        "login_not_ready",
        "아직 인증 코드를 입력할 수 있는 상태가 아닙니다.",
        409,
      );
    }

    const parsed = parseSubmittedCode(rawCode);
    if (parsed === null) {
      throw new ClaudeCentralLoginError("invalid_code", "올바르지 않은 Claude 인증 코드입니다.", 400);
    }
    if (parsed.state !== null && parsed.state !== flow.stateParam) {
      throw new ClaudeCentralLoginError("invalid_code", "인증 코드의 state가 일치하지 않습니다.", 400);
    }

    flow.state = "verifying";
    const clientId = await this.clientId();
    let exchanged: ClaudeCentralTokenExchangeResponse;
    try {
      exchanged = await this.tokenExchange({
        url: CLAUDE_OAUTH_TOKEN_URL,
        data: {
          grant_type: "authorization_code",
          client_id: clientId,
          code: parsed.code,
          redirect_uri: HEADLESS_REDIRECT_URI,
          code_verifier: flow.verifier,
          state: flow.stateParam,
        },
      });
    } catch {
      throw this.failFlow(flow, {
        code: "token_exchange_failed",
        message: "Token exchange request failed",
      }, 502);
    }

    if (exchanged.statusCode !== 200) {
      const rejected = exchanged.statusCode === 400 || exchanged.statusCode === 401;
      throw this.failFlow(flow, {
        code: rejected ? "invalid_code" : "token_exchange_failed",
        message: `Token exchange failed (HTTP ${exchanged.statusCode})`,
      }, rejected ? 400 : 502);
    }
    const token = parseTokenData(exchanged.body);
    if (token === undefined) {
      throw this.failFlow(flow, {
        code: "token_exchange_failed",
        message: "Token exchange failed: missing access_token",
      }, 502);
    }

    let profile: { readonly status: number; readonly body: unknown };
    try {
      profile = await this.fetchProfile(ANTHROPIC_PROFILE_URL, {
        Authorization: `Bearer ${token.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        Accept: "application/json",
      });
    } catch {
      throw this.failFlow(flow, {
        code: "profile_unavailable",
        message: "Profile request failed",
      }, 502);
    }
    if (profile.status !== 200) {
      throw this.failFlow(flow, {
        code: "profile_unavailable",
        message: `Profile fetch failed (HTTP ${profile.status})`,
      }, 502);
    }
    const identity = parseProfileIdentity(profile.body);
    if (identity.accountUuid === null || !UUID_PATTERN.test(identity.accountUuid)) {
      throw this.failFlow(flow, {
        code: "account_uuid_missing",
        message: "프로필에서 Claude 계정 uuid를 찾지 못했습니다.",
      }, 502);
    }
    if (identity.email === null) {
      throw this.failFlow(flow, {
        code: "profile_unavailable",
        message: "프로필에서 계정 이메일을 찾지 못했습니다.",
      }, 502);
    }

    const nowMs = this.now();
    const expiresIn = token.expiresIn;
    const tokenLifetimeSec =
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.trunc(expiresIn)
        : null;
    const record = await this.repository.upsertLogin({
      id: identity.accountUuid.toLowerCase(),
      email: identity.email,
      plan: identity.plan,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? null,
      expiresAt: tokenLifetimeSec === null
        ? null
        : new Date(nowMs + tokenLifetimeSec * 1_000).toISOString(),
      tokenLifetimeSec,
      scopes: token.scope ?? null,
      nowIso: new Date(nowMs).toISOString(),
    });
    flow.state = "done";
    flow.accountId = record.id;
    flow.error = null;
    this.onAccountLoggedIn?.(record);
    return snapshot(flow);
  }

  cancel(loginId: string): ClaudeCentralLoginSnapshot {
    const flow = this.requireFlow(loginId);
    if (!isTerminal(flow.state)) {
      flow.state = "cancelled";
      flow.error = null;
    }
    return snapshot(flow);
  }

  /** 이 계정에 붙은 진행 중 로그인 창의 만료 시각. 없으면 undefined. */
  activeLoginExpiresAt(accountId: string): string | undefined {
    for (const flow of this.flows.values()) {
      if (flow.accountId === accountId && flow.state === "url_ready") {
        return new Date(flow.expiresAtMs).toISOString();
      }
    }
    return undefined;
  }

  close(): void {
    this.flows.clear();
  }

  private requireFlow(loginId: string): LoginFlow {
    const flow = this.flows.get(loginId);
    if (flow === undefined) {
      throw new ClaudeCentralLoginError(
        "login_not_found",
        "Claude 로그인 세션을 찾을 수 없습니다.",
        404,
      );
    }
    if (
      (flow.state === "url_ready" || flow.state === "verifying")
      && this.now() > flow.expiresAtMs
    ) {
      flow.state = "failed";
      flow.error = { code: "login_timed_out", message: "Claude 로그인 시간이 지났습니다." };
    }
    return flow;
  }

  private failFlow(
    flow: LoginFlow,
    error: { code: string; message: string },
    statusCode: number,
  ): ClaudeCentralLoginError {
    flow.state = "failed";
    flow.error = error;
    return new ClaudeCentralLoginError(error.code, error.message, statusCode);
  }
}

function snapshot(flow: LoginFlow): ClaudeCentralLoginSnapshot {
  return {
    login_id: flow.loginId,
    account_id: flow.accountId,
    state: flow.state,
    auth_url: flow.authUrl,
    expires_at: new Date(flow.expiresAtMs).toISOString(),
    error: flow.error === null ? null : { ...flow.error },
  };
}

function isTerminal(state: ClaudeCentralLoginState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function parseSubmittedCode(raw: string): { code: string; state: string | null } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) return null;
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex === -1) return { code: trimmed, state: null };
  const code = trimmed.slice(0, hashIndex).trim();
  const state = trimmed.slice(hashIndex + 1).trim();
  return code.length === 0 ? null : { code, state: state.length === 0 ? null : state };
}

export function parseProfileIdentity(payload: unknown): {
  accountUuid: string | null;
  email: string | null;
  plan: string | null;
} {
  return {
    accountUuid: extractAccountUuid(payload),
    email: findString(payload, new Set(["email", "emailAddress", "email_address"])),
    plan: findString(
      payload,
      new Set(["plan", "subscriptionType", "subscription_type", "planType", "plan_type"]),
    ),
  };
}

function extractAccountUuid(value: unknown): string | null {
  if (isRecord(value) && isRecord(value.account) && typeof value.account.uuid === "string") {
    const trimmed = value.account.uuid.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return findString(value, new Set(["accountUuid", "account_uuid", "uuid", "userUuid", "user_uuid"]));
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.trim().length > 0) return item.trim();
  }
  for (const item of Object.values(value)) {
    const found = findString(item, keys);
    if (found) return found;
  }
  return null;
}

function createNodePkceProvider(): ClaudeCentralPkceProvider {
  return {
    generateVerifier: () => base64UrlNoPadding(randomBytes(32)),
    generateChallenge: (verifier) =>
      base64UrlNoPadding(createHash("sha256").update(verifier, "ascii").digest()),
    generateState: () => base64UrlNoPadding(randomBytes(32)),
  };
}

function base64UrlNoPadding(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const defaultTokenExchange: ClaudeCentralTokenExchange = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(request.data),
    signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    return { statusCode: response.status, text: await response.text() };
  }
  return { statusCode: response.status, body: await response.json() };
};

const defaultProfileFetcher: ClaudeCentralProfileFetcher = async (url, headers) => {
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
  });
  const body = response.status === 200 ? await response.json() : null;
  return { status: response.status, body };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
