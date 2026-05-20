import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "pino";

import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;
const MISSING_STORAGE_MESSAGE = "CLAUDE_AUTH_TOKEN_PATH is not configured";

export interface ClaudeAuthSetTokenCmd {
  type: "claude_auth_set_token";
  token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export interface ClaudeAuthCommandHandler {
  status(requestId: string, responseType: string): ClaudeAuthStatusResponse;
  setToken(
    cmd: ClaudeAuthSetTokenCmd,
    requestId: string,
    responseType: string,
  ): { response?: ClaudeAuthSetTokenResponse; error?: string };
  deleteToken(requestId: string, responseType: string): ClaudeAuthDeleteTokenResponse;
  fetchUsage(requestId: string, responseType: string): Promise<ClaudeAuthApiResponse>;
  fetchProfile(requestId: string, responseType: string): Promise<ClaudeAuthApiResponse>;
}

export interface ClaudeAuthStatusResponse {
  type: string;
  requestId: string;
  has_token: boolean;
  configured?: boolean;
  error?: string;
  has_refresh_token?: boolean;
  expires_at?: number;
  scopes?: string[];
}

export interface ClaudeAuthSetTokenResponse {
  type: string;
  requestId: string;
  success: boolean;
}

export interface ClaudeAuthDeleteTokenResponse {
  type: string;
  requestId: string;
  success: boolean;
  error?: string;
}

export interface ClaudeAuthApiResponse {
  type: string;
  requestId: string;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface ClaudeAuthHttpResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type ClaudeAuthHttpGet = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<ClaudeAuthHttpResponse>;

export interface ClaudeAuthServiceConfig {
  store: ClaudeAuthTokenStore;
  httpGet?: ClaudeAuthHttpGet;
}

interface StoredClaudeCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

interface StoredClaudeCredentialsFile {
  claudeAiOauth: StoredClaudeCredentials;
  updatedAt: string;
}

export interface ClaudeAuthTokenStore {
  isConfigured(): boolean;
  read(): StoredClaudeCredentials | null;
  write(credentials: StoredClaudeCredentials): void;
  delete(): boolean;
}

export class FileClaudeAuthTokenStore implements ClaudeAuthTokenStore {
  private readonly tokenPath?: string;

  constructor(tokenPath: string | undefined) {
    const trimmed = tokenPath?.trim();
    this.tokenPath = trimmed && trimmed.length > 0 ? trimmed : undefined;
  }

  isConfigured(): boolean {
    return this.tokenPath !== undefined;
  }

  read(): StoredClaudeCredentials | null {
    const tokenPath = this.requirePath();
    if (!existsSync(tokenPath)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(tokenPath, "utf-8"));
    } catch (err) {
      throw new Error(`failed to read Claude auth token file: ${stringifyError(err)}`);
    }

    if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) {
      throw new Error("stored Claude auth credentials are malformed");
    }
    const raw = parsed.claudeAiOauth;
    const token = normalizeTokenValue(raw.accessToken);
    if ("error" in token) {
      throw new Error(`stored Claude auth token is invalid: ${token.error}`);
    }

    const out: StoredClaudeCredentials = { accessToken: token.token };
    if (typeof raw.refreshToken === "string" && raw.refreshToken.trim()) {
      out.refreshToken = raw.refreshToken;
    }
    if (typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)) {
      out.expiresAt = raw.expiresAt;
    }
    if (Array.isArray(raw.scopes)) {
      out.scopes = raw.scopes.filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      );
    }
    return out;
  }

  write(credentials: StoredClaudeCredentials): void {
    const tokenPath = this.requirePath();
    mkdirSync(dirname(tokenPath), { recursive: true });
    const payload: StoredClaudeCredentialsFile = {
      claudeAiOauth: credentials,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(tokenPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(tokenPath, 0o600);
  }

  delete(): boolean {
    const tokenPath = this.requirePath();
    if (!existsSync(tokenPath)) {
      return false;
    }
    unlinkSync(tokenPath);
    return true;
  }

  private requirePath(): string {
    if (!this.tokenPath) {
      throw new MissingClaudeAuthStorageError(MISSING_STORAGE_MESSAGE);
    }
    return this.tokenPath;
  }
}

export class ClaudeAuthService implements ClaudeAuthCommandHandler {
  private readonly store: ClaudeAuthTokenStore;
  private readonly httpGet: ClaudeAuthHttpGet;

  constructor(config: ClaudeAuthServiceConfig, private readonly logger: Logger) {
    this.store = config.store;
    this.httpGet = config.httpGet ?? defaultHttpGet;
  }

  status(requestId: string, responseType: string): ClaudeAuthStatusResponse {
    try {
      const credentials = this.store.read();
      if (!credentials) {
        return {
          type: responseType,
          requestId,
          has_token: false,
          configured: true,
        };
      }
      return {
        type: responseType,
        requestId,
        has_token: true,
        configured: true,
        has_refresh_token: Boolean(credentials.refreshToken),
        ...(credentials.expiresAt !== undefined ? { expires_at: credentials.expiresAt } : {}),
        ...(credentials.scopes ? { scopes: credentials.scopes } : {}),
      };
    } catch (err) {
      return {
        type: responseType,
        requestId,
        has_token: false,
        configured: !(err instanceof MissingClaudeAuthStorageError),
        error: stringifyError(err),
      };
    }
  }

  setToken(
    cmd: ClaudeAuthSetTokenCmd,
    requestId: string,
    responseType: string,
  ): { response?: ClaudeAuthSetTokenResponse; error?: string } {
    const token = normalizeTokenValue(cmd.token);
    if ("error" in token) {
      return { error: token.error };
    }

    const refreshToken = normalizeOptionalString(cmd.refresh_token);
    const scopes = normalizeScopes(cmd.scope);
    const credentials: StoredClaudeCredentials = {
      accessToken: token.token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof cmd.expires_in === "number" && Number.isFinite(cmd.expires_in)
        ? { expiresAt: Date.now() + cmd.expires_in * 1000 }
        : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
    };

    try {
      this.store.write(credentials);
      this.logger.info("Claude Code OAuth token stored via TS auth command");
      return {
        response: {
          type: responseType,
          requestId,
          success: true,
        },
      };
    } catch (err) {
      return { error: stringifyError(err) };
    }
  }

  deleteToken(requestId: string, responseType: string): ClaudeAuthDeleteTokenResponse {
    try {
      const deleted = this.store.delete();
      this.logger.info({ deleted }, "Claude Code OAuth token deleted via TS auth command");
      return {
        type: responseType,
        requestId,
        success: true,
      };
    } catch (err) {
      return {
        type: responseType,
        requestId,
        success: false,
        error: stringifyError(err),
      };
    }
  }

  async fetchUsage(requestId: string, responseType: string): Promise<ClaudeAuthApiResponse> {
    return this.fetchAuthApi(ANTHROPIC_USAGE_URL, requestId, responseType);
  }

  async fetchProfile(requestId: string, responseType: string): Promise<ClaudeAuthApiResponse> {
    return this.fetchAuthApi(ANTHROPIC_PROFILE_URL, requestId, responseType);
  }

  buildProcessEnv(
    baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  ): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (key !== CLAUDE_OAUTH_TOKEN_ENV) {
        out[key] = value;
      }
    }
    const credentials = this.store.read();
    if (credentials) {
      out[CLAUDE_OAUTH_TOKEN_ENV] = credentials.accessToken;
    }
    return out;
  }

  private async fetchAuthApi(
    apiUrl: string,
    requestId: string,
    responseType: string,
  ): Promise<ClaudeAuthApiResponse> {
    let token: string | null;
    try {
      token = this.store.read()?.accessToken ?? null;
    } catch (err) {
      return {
        type: responseType,
        requestId,
        success: false,
        error: stringifyError(err),
      };
    }
    if (!token) {
      return {
        type: responseType,
        requestId,
        success: false,
        error: "no token",
      };
    }

    try {
      const resp = await this.httpGet(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": CLAUDE_OAUTH_BETA,
        },
      });
      if (resp.status !== 200) {
        return {
          type: responseType,
          requestId,
          success: false,
          error: (await resp.text()) || `HTTP ${resp.status}`,
        };
      }
      const data = await resp.json();
      return {
        type: responseType,
        requestId,
        success: true,
        data: isRecord(data) ? data : { value: data },
      };
    } catch (err) {
      return {
        type: responseType,
        requestId,
        success: false,
        error: stringifyError(err),
      };
    }
  }
}

class MissingClaudeAuthStorageError extends Error {}

function normalizeTokenValue(
  value: unknown,
): { token: string; error?: undefined } | { error: string } {
  if (typeof value !== "string") {
    return { error: "token is required" };
  }
  const token = value.trim();
  if (!token) {
    return { error: "token is required" };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { error: "invalid token format" };
  }
  return { token };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeScopes(value: unknown): string[] {
  const scope = normalizeOptionalString(value);
  if (!scope) return [];
  return scope.split(/\s+/).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const defaultHttpGet: ClaudeAuthHttpGet = async (url, init) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("global fetch is not available");
  }
  const resp = await globalThis.fetch(url, { headers: init.headers });
  return {
    status: resp.status,
    text: () => resp.text(),
    json: () => resp.json() as Promise<unknown>,
  };
};
