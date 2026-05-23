import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ClaudeAuthCommandHandler } from "./claude_auth.js";

export type ProviderUsageName = "claude" | "codex" | "gemini";

export interface ProviderQuota {
  id: string;
  label: string;
  window: string | null;
  unit: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  model: string | null;
  source: string | null;
}

export interface ProviderLimits {
  status: "auto" | "not_configured" | "error";
  source: string;
  weeklyTokens: number | null;
  monthlyTokens: number | null;
  sessionTokens: number | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: number | null;
  shortUsedPercent: number | null;
  shortWindowMinutes: number | null;
  shortResetAt: number | null;
  planType: string | null;
  quotas: ProviderQuota[];
  error?: string;
}

export interface ProviderUsageSnapshot {
  generatedAt: string;
  providers: Record<ProviderUsageName, ProviderLimits>;
}

export interface ProviderUsageResponse {
  type: string;
  requestId: string;
  success: boolean;
  data?: ProviderUsageSnapshot | ProviderLimits;
  error?: string;
}

export interface ProviderUsageCommandHandler {
  fetchUsage(
    requestId: string,
    responseType: string,
    provider?: ProviderUsageName,
  ): Promise<ProviderUsageResponse>;
}

export interface ProviderUsageServiceConfig {
  claudeAuth?: ClaudeAuthCommandHandler;
  homeDir?: string;
  fetchImpl?: typeof fetch;
}

const CODEX_USAGE_URLS = [
  "https://chatgpt.com/backend-api/codex/usage",
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/api/codex/usage",
] as const;
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const GEMINI_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_OAUTH_CLIENT_ID_RE = /const OAUTH_CLIENT_ID = '([^']+)'/;
const GEMINI_OAUTH_CLIENT_SECRET_RE = /const OAUTH_CLIENT_SECRET = '([^']+)'/;
const LOCAL_PROVIDER_MAX_FILES = 10000;

export class ProviderUsageService implements ProviderUsageCommandHandler {
  private readonly homeDir: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: ProviderUsageServiceConfig = {}) {
    this.homeDir = config.homeDir ?? homedir();
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async fetchUsage(
    requestId: string,
    responseType: string,
    provider?: ProviderUsageName,
  ): Promise<ProviderUsageResponse> {
    try {
      const data = provider
        ? await this.fetchProvider(provider)
        : await this.fetchSnapshot();
      return {
        type: responseType,
        requestId,
        success: true,
        data,
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

  async fetchSnapshot(): Promise<ProviderUsageSnapshot> {
    const [claude, codex, gemini] = await Promise.all([
      this.fetchClaudeLimits(),
      this.fetchCodexLimits(),
      this.fetchGeminiLimits(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      providers: { claude, codex, gemini },
    };
  }

  async fetchProvider(provider: ProviderUsageName): Promise<ProviderLimits> {
    switch (provider) {
      case "claude":
        return this.fetchClaudeLimits();
      case "codex":
        return this.fetchCodexLimits();
      case "gemini":
        return this.fetchGeminiLimits();
    }
  }

  private async fetchClaudeLimits(): Promise<ProviderLimits> {
    if (!this.config.claudeAuth) {
      return emptyLimits();
    }
    const result = await this.config.claudeAuth.fetchUsage("", "provider_usage_get");
    if (!result.success) {
      return result.error === "no token"
        ? emptyLimits()
        : emptyLimits("error", result.error ?? "Claude usage request failed");
    }
    return claudeLimitsFromUsageResponse(result.data ?? {});
  }

  private async fetchCodexLimits(): Promise<ProviderLimits> {
    const auth = readJson(join(this.homeDir, ".codex", "auth.json"));
    if (!isRecord(auth)) {
      return codexRuntimeLimits(this.homeDir);
    }

    const tokens = oauthTokens(auth);
    let accessToken = optionalString(tokens.access_token);
    const accountId = optionalString(tokens.account_id) ?? optionalString(auth.account_id) ?? "";
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (accessToken) {
        for (const url of CODEX_USAGE_URLS) {
          try {
            const payload = await this.codexUsageRequest(accessToken, accountId, url);
            return codexLimitsFromUsageResponse(payload, url);
          } catch (err) {
            lastError = err;
          }
        }
      }
      if (attempt === 0) {
        accessToken = await this.refreshCodexAccessToken(auth).catch((err) => {
          lastError = err;
          return null;
        });
      }
    }

    const fallback = codexRuntimeLimits(this.homeDir);
    if (fallback.status !== "not_configured") {
      return {
        ...fallback,
        error: lastError ? stringifyError(lastError) : undefined,
      };
    }
    return emptyLimits("error", lastError ? stringifyError(lastError) : "Codex OAuth token unavailable");
  }

  private async fetchGeminiLimits(): Promise<ProviderLimits> {
    const creds = readJson(join(this.homeDir, ".gemini", "oauth_creds.json"));
    if (!isRecord(creds)) {
      return emptyLimits();
    }
    const authType = readGeminiAuthType(this.homeDir);
    if (authType && authType !== "oauth-personal") {
      return emptyLimits();
    }

    try {
      const token = await this.geminiAccessToken(creds);
      if (!token) {
        return emptyLimits();
      }

      let projectId =
        optionalString(process.env.GOOGLE_CLOUD_PROJECT) ??
        optionalString(process.env.GOOGLE_CLOUD_PROJECT_ID) ??
        "";
      const metadata: Record<string, string> = {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      };
      if (projectId) {
        metadata.duetProject = projectId;
      }

      const tierPayload = await this.geminiCodeAssistPost(
        "loadCodeAssist",
        { cloudaicompanionProject: projectId, metadata },
        token,
      );
      projectId = optionalString(tierPayload.cloudaicompanionProject) ?? projectId;
      if (!projectId) {
        return emptyLimits("error", "Gemini Code Assist project ID unavailable");
      }

      const quotaPayload = await this.geminiCodeAssistPost(
        "retrieveUserQuota",
        { project: projectId },
        token,
      );
      return geminiLimitsFromQuotaResponse(
        quotaPayload,
        tierPayload,
        GEMINI_CODE_ASSIST_URL,
      );
    } catch (err) {
      return emptyLimits("error", stringifyError(err));
    }
  }

  private async codexUsageRequest(
    accessToken: string,
    accountId: string,
    url: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "AgentCat/1.0",
    };
    if (accountId) {
      headers["chatgpt-account-id"] = accountId;
    }
    return this.fetchJson(url, { headers });
  }

  private async refreshCodexAccessToken(auth: Record<string, unknown>): Promise<string | null> {
    const refreshToken = optionalString(oauthTokens(auth).refresh_token);
    if (!refreshToken) {
      return null;
    }
    const payload = await this.fetchJson(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }).toString(),
    });
    return optionalString(payload.access_token);
  }

  private async geminiAccessToken(creds: Record<string, unknown>): Promise<string | null> {
    const expiresAt = intValue(creds.expiry_date) ?? 0;
    if (expiresAt && Date.now() >= expiresAt - 60_000) {
      const refreshed = await this.refreshGeminiAccessToken(creds);
      return optionalString(refreshed.access_token);
    }
    return optionalString(creds.access_token);
  }

  private async refreshGeminiAccessToken(
    creds: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const refreshToken = optionalString(creds.refresh_token);
    if (!refreshToken) {
      throw new Error("No refresh token in ~/.gemini/oauth_creds.json");
    }
    const [clientId, clientSecret] = geminiOauthClientCredentials(this.homeDir, creds);
    const payload = await this.fetchJson(GEMINI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    return {
      ...creds,
      access_token: payload.access_token ?? creds.access_token,
      token_type: payload.token_type ?? creds.token_type ?? "Bearer",
      expiry_date: Date.now() + (intValue(payload.expires_in) ?? 3600) * 1000,
      ...(payload.id_token ? { id_token: payload.id_token } : {}),
    };
  }

  private async geminiCodeAssistPost(
    method: string,
    payload: Record<string, unknown>,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    return this.fetchJson(`${GEMINI_CODE_ASSIST_URL}:${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "AgentCat/1.0",
      },
      body: JSON.stringify(payload),
    });
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is not available");
    }
    const resp = await this.fetchImpl(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(text || `HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as unknown;
    return isRecord(data) ? data : {};
  }
}

export function claudeLimitsFromUsageResponse(
  payload: Record<string, unknown>,
  source = "https://api.anthropic.com/api/oauth/usage",
): ProviderLimits {
  const limits = emptyLimits("auto");
  limits.source = source;
  const quotas: ProviderQuota[] = [];

  for (const [key, entry] of Object.entries(payload)) {
    if (!isRecord(entry)) continue;
    if (entry.is_enabled === false) continue;

    if (key === "extra_usage" || entry.monthly_limit !== undefined) {
      const limit = floatValue(entry.monthly_limit);
      const used = floatValue(entry.used_credits) ?? 0;
      const currency = optionalString(entry.currency) ?? "credits";
      if (limit !== null && limit > 0) {
        quotas.push(
          quotaEntry(claudeQuotaId(key), claudeQuotaLabel(key), {
            usedPercent: clampPercent((used / limit) * 100),
            used,
            remaining: Math.max(limit - used, 0),
            limit,
            unit: currency,
            window: "monthly",
            model: claudeQuotaModel(key),
            source,
          }),
        );
      }
      continue;
    }

    const used = floatPercent(firstPresent(entry.utilization, entry.used_percentage));
    if (used === null) continue;

    const quota = quotaEntry(claudeQuotaId(key), claudeQuotaLabel(key), {
      usedPercent: used,
      resetAt: entry.resets_at,
      window: key === "five_hour" ? "5h" : key.startsWith("seven_day") ? "7d" : null,
      model: claudeQuotaModel(key),
      source,
    });
    quotas.push(quota);
    if (key === "five_hour") {
      limits.shortUsedPercent = quota.usedPercent;
      limits.shortWindowMinutes = 300;
      limits.shortResetAt = quota.resetAt;
    } else if (key === "seven_day") {
      limits.weeklyUsedPercent = quota.usedPercent;
      limits.weeklyResetAt = quota.resetAt;
    }
  }

  quotas.sort((a, b) => claudeQuotaSortKey(a).localeCompare(claudeQuotaSortKey(b)));
  limits.quotas = quotas;
  if (quotas.length === 0) {
    limits.status = "not_configured";
  }
  return limits;
}

export function codexLimitsFromUsageResponse(
  payload: Record<string, unknown>,
  source = "codex-usage-api",
): ProviderLimits {
  const limits = emptyLimits("auto");
  limits.source = source;
  limits.planType =
    optionalString(payload.plan_type) ?? optionalString(payload.plan) ?? null;

  const rateLimit = isRecord(payload.rate_limit)
    ? payload.rate_limit
    : isRecord(payload.rate_limits)
      ? payload.rate_limits
      : {};
  const quotas: ProviderQuota[] = [];

  const primary = firstRecord(rateLimit.primary_window, rateLimit.primary);
  const primaryQuota = codexWindowQuota("codex:5h", "5시간", primary, source);
  if (primaryQuota) {
    quotas.push(primaryQuota);
    limits.shortUsedPercent = primaryQuota.usedPercent;
    limits.shortResetAt = primaryQuota.resetAt;
    const seconds = intValue(firstPresent(primary?.limit_window_seconds, primary?.window_secs));
    if (seconds) {
      limits.shortWindowMinutes = Math.floor(seconds / 60);
    }
  }

  const secondary = firstRecord(rateLimit.secondary_window, rateLimit.secondary);
  const secondaryQuota = codexWindowQuota("codex:7d", "7일", secondary, source);
  if (secondaryQuota) {
    quotas.push(secondaryQuota);
    limits.weeklyUsedPercent = secondaryQuota.usedPercent;
    limits.weeklyResetAt = secondaryQuota.resetAt;
  }

  if (Array.isArray(payload.additional_rate_limits)) {
    for (const item of payload.additional_rate_limits) {
      if (!isRecord(item)) continue;
      const name = optionalString(item.limit_name) ?? optionalString(item.name) ?? "model";
      const subRate = isRecord(item.rate_limit) ? item.rate_limit : {};
      const p = codexWindowQuota(
        `codex:${name}:primary`,
        `${name} 5시간`,
        firstRecord(subRate.primary_window, subRate.primary),
        source,
        name,
      );
      if (p) quotas.push(p);
      const s = codexWindowQuota(
        `codex:${name}:secondary`,
        `${name} 7일`,
        firstRecord(subRate.secondary_window, subRate.secondary),
        source,
        name,
      );
      if (s) quotas.push(s);
    }
  }

  if (isRecord(payload.code_review_rate_limit)) {
    const reviewQuota = codexWindowQuota(
      "codex:code_review",
      "리뷰",
      firstRecord(
        payload.code_review_rate_limit.primary_window,
        payload.code_review_rate_limit.primary,
      ),
      source,
    );
    if (reviewQuota) quotas.push(reviewQuota);
  }

  limits.quotas = quotas;
  if (quotas.length === 0 && !limits.planType) {
    limits.status = "not_configured";
  }
  return limits;
}

export function geminiLimitsFromQuotaResponse(
  quotaPayload: Record<string, unknown>,
  tierPayload: Record<string, unknown> = {},
  source = "gemini-code-assist-quota-api",
): ProviderLimits {
  const limits = emptyLimits("auto");
  limits.source = source;
  const currentTier = isRecord(tierPayload.currentTier) ? tierPayload.currentTier : {};
  const paidTier = isRecord(tierPayload.paidTier) ? tierPayload.paidTier : {};
  const plan =
    optionalString(paidTier.name) ??
    optionalString(currentTier.name) ??
    optionalString(paidTier.id) ??
    optionalString(currentTier.id);
  limits.planType = plan ?? null;

  const quotas: ProviderQuota[] = [];
  if (Array.isArray(quotaPayload.buckets)) {
    for (const bucket of quotaPayload.buckets) {
      if (!isRecord(bucket)) continue;
      const model = optionalString(bucket.modelId) ?? "";
      const remainingFraction = floatValue(bucket.remainingFraction);
      const remainingPercent =
        remainingFraction === null ? null : clampPercent(remainingFraction * 100);
      const usedPercent =
        remainingPercent === null ? null : clampPercent(100 - remainingPercent);
      const remaining = intValue(bucket.remainingAmount);
      const limit =
        remaining !== null && remainingFraction !== null && remainingFraction > 0
          ? Math.round(remaining / remainingFraction)
          : null;
      const tokenType = (optionalString(bucket.tokenType) ?? "REQUESTS").toLowerCase();
      quotas.push(
        quotaEntry(`gemini:${model || quotas.length}`, geminiDisplayName(model), {
          usedPercent,
          remainingPercent,
          resetAt: bucket.resetTime,
          unit: tokenType === "requests" ? "requests" : tokenType,
          used: remaining === null || limit === null ? null : Math.max(limit - remaining, 0),
          remaining,
          limit,
          window: "daily",
          model: model || null,
          source,
        }),
      );
    }
  }

  limits.quotas = sortedGeminiQuotas(quotas);
  if (limits.quotas.length === 0) {
    limits.status = "not_configured";
  }
  return limits;
}

function codexRuntimeLimits(homeDir: string): ProviderLimits {
  const sessionsDir = join(homeDir, ".codex", "sessions");
  const files = findFiles(sessionsDir, (path) => path.endsWith(".jsonl") && path.includes("rollout-"))
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a))
    .slice(0, 30);

  for (const path of files) {
    let lines: string[];
    try {
      lines = readFileSync(path, "utf-8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.includes("rate_limits")) continue;
      let item: unknown;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = isRecord(item) && isRecord(item.payload) ? item.payload : null;
      if (!payload || payload.type !== "token_count" || !isRecord(payload.rate_limits)) {
        continue;
      }
      const limits = emptyLimits("auto");
      limits.source = path;
      limits.planType = optionalString(payload.rate_limits.plan_type) ?? null;

      const quotas: ProviderQuota[] = [];
      const primary = isRecord(payload.rate_limits.primary) ? payload.rate_limits.primary : null;
      const secondary = isRecord(payload.rate_limits.secondary) ? payload.rate_limits.secondary : null;
      const primaryQuota = codexRuntimeQuota("codex:5h", "5시간", primary, path);
      if (primaryQuota) {
        quotas.push(primaryQuota);
        limits.shortUsedPercent = primaryQuota.usedPercent;
        limits.shortWindowMinutes = intValue(primary?.window_minutes);
        limits.shortResetAt = primaryQuota.resetAt;
      }
      const secondaryQuota = codexRuntimeQuota("codex:7d", "7일", secondary, path);
      if (secondaryQuota) {
        quotas.push(secondaryQuota);
        limits.weeklyUsedPercent = secondaryQuota.usedPercent;
        limits.weeklyResetAt = secondaryQuota.resetAt;
      }
      if (isRecord(payload.info)) {
        limits.sessionTokens = intValue(payload.info.model_context_window);
      }
      limits.quotas = quotas;
      if (quotas.length > 0 || limits.sessionTokens !== null) {
        return limits;
      }
    }
  }
  return emptyLimits();
}

function codexRuntimeQuota(
  id: string,
  label: string,
  window: Record<string, unknown> | null,
  source: string,
): ProviderQuota | null {
  if (!window) return null;
  const used = floatPercent(window.used_percent);
  if (used === null) return null;
  const minutes = intValue(window.window_minutes);
  return quotaEntry(id, label, {
    usedPercent: used,
    resetAt: window.resets_at,
    window: minutes ? `${Math.floor(minutes / 60)}h` : null,
    source,
  });
}

function codexWindowQuota(
  id: string,
  label: string,
  window: Record<string, unknown> | null,
  source: string,
  model?: string,
): ProviderQuota | null {
  if (!window) return null;
  const used = floatPercent(firstPresent(window.used_percent, window.utilization));
  if (used === null) return null;
  const seconds = intValue(firstPresent(window.limit_window_seconds, window.window_secs));
  return quotaEntry(id, label, {
    usedPercent: used,
    resetAt: firstPresent(window.reset_at, window.resets_at),
    window: seconds && seconds % 3600 === 0 ? `${Math.floor(seconds / 3600)}h` : null,
    model: model ?? null,
    source,
  });
}

function readGeminiAuthType(homeDir: string): string | null {
  for (const path of [
    join(process.cwd(), ".gemini", "settings.json"),
    join(homeDir, ".gemini", "settings.json"),
  ]) {
    const raw = readJson(path);
    if (!isRecord(raw) || !isRecord(raw.security) || !isRecord(raw.security.auth)) {
      continue;
    }
    const selected = optionalString(raw.security.auth.selectedType);
    if (selected) return selected;
  }
  if (process.env.GOOGLE_GENAI_USE_GCA === "true") return "oauth-personal";
  if (process.env.GEMINI_API_KEY) return "gemini-api-key";
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true") return "vertex-ai";
  return null;
}

function geminiOauthClientCredentials(
  homeDir: string,
  creds: Record<string, unknown>,
): [string, string] {
  const envId = optionalString(process.env.GEMINI_OAUTH_CLIENT_ID);
  const envSecret = optionalString(process.env.GEMINI_OAUTH_CLIENT_SECRET);
  if (envId && envSecret) return [envId, envSecret];

  const credId = optionalString(creds.client_id);
  const credSecret = optionalString(creds.client_secret);
  if (credId && credSecret) return [credId, credSecret];

  const live = geminiCliOauthClientCredentials(homeDir);
  if (live) return live;
  throw new Error(
    "Gemini OAuth metadata not found; run `gemini` once or set GEMINI_OAUTH_CLIENT_ID/GEMINI_OAUTH_CLIENT_SECRET",
  );
}

function geminiCliOauthClientCredentials(homeDir: string): [string, string] | null {
  const rels = [
    join("node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
    join(
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    ),
    join(
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    ),
  ];
  for (const root of geminiOauthSourceCandidates(homeDir)) {
    for (const rel of rels) {
      const path = join(root, rel);
      const found = readGeminiOauthFile(path);
      if (found) return found;
    }
  }
  return null;
}

function geminiOauthSourceCandidates(homeDir: string): string[] {
  const candidates = new Set<string>();
  const gemini = findOnPath("gemini");
  if (gemini) {
    const dir = dirname(resolve(gemini));
    candidates.add(dir);
    candidates.add(dirname(dir));
    candidates.add(join(dirname(dir), "libexec"));
  }
  candidates.add("/opt/homebrew/lib");
  candidates.add("/opt/homebrew/Cellar/gemini-cli");
  candidates.add("/usr/local/lib");
  const nvmVersions = join(homeDir, ".nvm", "versions");
  candidates.add(nvmVersions);
  for (const familyDir of safeChildDirs(nvmVersions)) {
    candidates.add(familyDir);
    for (const versionDir of safeChildDirs(familyDir)) {
      candidates.add(versionDir);
      candidates.add(join(versionDir, "lib"));
    }
  }
  return [...candidates].filter((path) => existsSync(path));
}

function safeChildDirs(path: string): string[] {
  try {
    return readdirSync(path)
      .map((entry) => join(path, entry))
      .filter((entryPath) => statSync(entryPath).isDirectory());
  } catch {
    return [];
  }
}

function readGeminiOauthFile(path: string): [string, string] | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const clientId = GEMINI_OAUTH_CLIENT_ID_RE.exec(text)?.[1];
    const clientSecret = GEMINI_OAUTH_CLIENT_SECRET_RE.exec(text)?.[1];
    return clientId && clientSecret ? [clientId, clientSecret] : null;
  } catch {
    return null;
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function sortedGeminiQuotas(quotas: ProviderQuota[]): ProviderQuota[] {
  if (quotas.length > 3) {
    return quotas.sort((a, b) => {
      const remainingA = a.remainingPercent ?? (a.usedPercent === null ? Infinity : 100 - a.usedPercent);
      const remainingB = b.remainingPercent ?? (b.usedPercent === null ? Infinity : 100 - b.usedPercent);
      return (
        remainingA - remainingB ||
        (a.resetAt ?? Number.MAX_SAFE_INTEGER) - (b.resetAt ?? Number.MAX_SAFE_INTEGER) ||
        a.label.localeCompare(b.label)
      );
    });
  }
  return quotas.sort((a, b) => {
    const aPro = (a.model ?? "").toLowerCase().includes("pro") ? 0 : 1;
    const bPro = (b.model ?? "").toLowerCase().includes("pro") ? 0 : 1;
    return aPro - bPro || a.label.localeCompare(b.label);
  });
}

function geminiDisplayName(model: string): string {
  const names: Record<string, string> = {
    "gemini-2.5-pro": "Gemini Pro",
    "gemini-2.5-flash": "Gemini Flash",
    "gemini-2.5-flash-lite": "Gemini Flash Lite",
    "gemini-3-pro-preview": "Gemini 3 Pro",
    "gemini-3-flash-preview": "Gemini 3 Flash",
    "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  };
  return names[model] ?? model ?? "Gemini";
}

function claudeQuotaLabel(key: string): string {
  const labels: Record<string, string> = {
    five_hour: "5시간",
    seven_day: "7일",
    seven_day_sonnet: "7일 (Sonnet)",
    seven_day_opus: "7일 (Opus)",
    seven_day_oauth_apps: "7일 (OAuth Apps)",
    seven_day_cowork: "7일 (협업)",
    extra_usage: "월간 추가 사용량",
    iguana_necktie: "기타",
  };
  return labels[key] ?? key;
}

function claudeQuotaId(key: string): string {
  if (key === "five_hour") return "claude:five_hour";
  if (key === "seven_day") return "claude:seven_day";
  if (key === "extra_usage") return "claude:monthly_extra";
  return `claude:${key}`;
}

function claudeQuotaModel(key: string): string | null {
  if (key.includes("sonnet")) return "sonnet";
  if (key.includes("opus")) return "opus";
  return null;
}

function claudeQuotaSortKey(quota: ProviderQuota): string {
  const order: Record<string, string> = {
    "claude:five_hour": "00",
    "claude:seven_day": "01",
    "claude:seven_day_sonnet": "02",
    "claude:seven_day_opus": "03",
    "claude:seven_day_oauth_apps": "04",
    "claude:seven_day_cowork": "05",
    "claude:monthly_extra": "90",
  };
  return `${order[quota.id] ?? "99"}:${quota.id}`;
}

function quotaEntry(
  id: string,
  label: string,
  values: {
    usedPercent?: unknown;
    remainingPercent?: unknown;
    resetAt?: unknown;
    unit?: string | null;
    used?: unknown;
    remaining?: unknown;
    limit?: unknown;
    window?: string | null;
    model?: string | null;
    source?: string | null;
  } = {},
): ProviderQuota {
  let usedPercent = floatPercent(values.usedPercent);
  let remainingPercent = floatPercent(values.remainingPercent);
  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = clampPercent(100 - usedPercent);
  }
  if (usedPercent === null && remainingPercent !== null) {
    usedPercent = clampPercent(100 - remainingPercent);
  }
  return {
    id,
    label,
    window: values.window ?? null,
    unit: values.unit ?? "percent",
    used: floatValue(values.used),
    remaining: floatValue(values.remaining),
    limit: floatValue(values.limit),
    usedPercent,
    remainingPercent,
    resetAt: resetEpoch(values.resetAt),
    model: values.model ?? null,
    source: values.source ?? null,
  };
}

function emptyLimits(
  status: ProviderLimits["status"] = "not_configured",
  error?: string,
): ProviderLimits {
  return {
    status,
    source: "",
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent: null,
    weeklyResetAt: null,
    shortUsedPercent: null,
    shortWindowMinutes: null,
    shortResetAt: null,
    planType: null,
    quotas: [],
    ...(error ? { error } : {}),
  };
}

function oauthTokens(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.tokens) ? raw.tokens : raw;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function findFiles(
  root: string,
  predicate: (path: string) => boolean,
  found: string[] = [],
): string[] {
  if (!existsSync(root) || found.length >= LOCAL_PROVIDER_MAX_FILES) return found;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= LOCAL_PROVIDER_MAX_FILES) break;
    const path = join(root, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      findFiles(path, predicate, found);
    } else if (predicate(path)) {
      found.push(path);
    }
  }
  return found;
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined);
}

function intValue(raw: unknown): number | null {
  if (typeof raw === "boolean") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const value = Math.trunc(raw);
    return value >= 0 ? value : null;
  }
  if (typeof raw === "string") {
    const value = Number.parseInt(raw.trim().replaceAll(",", "").replaceAll("_", ""), 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}

function floatValue(raw: unknown): number | null {
  if (typeof raw === "boolean") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const value = Number.parseFloat(raw.trim().replaceAll(",", "").replaceAll("_", ""));
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function floatPercent(raw: unknown): number | null {
  const value =
    typeof raw === "string" ? floatValue(raw.trim().replace(/%$/, "")) : floatValue(raw);
  return value === null ? null : clampPercent(value);
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

function resetEpoch(raw: unknown): number | null {
  const int = intValue(raw);
  if (int !== null) {
    return int > 1_000_000_000_000 ? Math.floor(int / 1000) : int;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
