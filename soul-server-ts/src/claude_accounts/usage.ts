import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ClaudeAccountAuthState,
  ClaudeAccountUsage,
  ClaudeUsageWindow,
} from "./types.js";

const DEFAULT_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_POLL_TTL_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_PER_ACCOUNT_TIMEOUT_MS = 4_000;

export function emptyClaudeAccountUsage(): ClaudeAccountUsage {
  return {
    five_hour: null,
    seven_day: null,
    fable_weekly: null,
  };
}

interface ParsedCredentials {
  accessToken: string;
  expiresAtMs: number | null;
}

export function readProfileCredentialsReadOnly(
  profileDir: string,
): ParsedCredentials | null {
  const credPath = path.join(profileDir, ".credentials.json");
  let raw: string;
  try {
    raw = fs.readFileSync(credPath, "utf8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const oauth =
    parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
      ? (parsed.claudeAiOauth as Record<string, unknown>)
      : parsed;

  const accessToken =
    typeof oauth.accessToken === "string"
      ? oauth.accessToken.trim()
      : typeof oauth.access_token === "string"
        ? oauth.access_token.trim()
        : "";

  if (!accessToken) {
    return null;
  }

  const rawExpires = oauth.expiresAt ?? oauth.expires_at;
  let expiresAtMs: number | null = null;
  if (typeof rawExpires === "number" && Number.isFinite(rawExpires)) {
    // Support both epoch milliseconds and epoch seconds
    expiresAtMs = rawExpires > 1e11 ? rawExpires : rawExpires * 1000;
  } else if (typeof rawExpires === "string" && rawExpires.trim()) {
    const asNum = Number(rawExpires);
    if (Number.isFinite(asNum)) {
      expiresAtMs = asNum > 1e11 ? asNum : asNum * 1000;
    } else {
      const asDate = Date.parse(rawExpires);
      if (Number.isFinite(asDate)) {
        expiresAtMs = asDate;
      }
    }
  }

  return {
    accessToken,
    expiresAtMs,
  };
}

function normalizeResetIso(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) {
      return trimmed;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num) && num > 0) {
      return new Date(num > 1e11 ? num : num * 1000).toISOString();
    }
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return new Date(raw > 1e11 ? raw : raw * 1000).toISOString();
  }
  return null;
}

function parseWindowNode(node: unknown): ClaudeUsageWindow | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const obj = node as Record<string, unknown>;
  const rawPct =
    obj.utilization ??
    obj.used_percent ??
    obj.usedPercent ??
    obj.percent_used ??
    obj.percentage;
  const numPct = typeof rawPct === "number" ? rawPct : Number(rawPct);
  if (!Number.isFinite(numPct)) {
    return null;
  }
  const resets_at = normalizeResetIso(
    obj.resets_at ?? obj.reset_at ?? obj.resetsAt ?? obj.resetAt,
  );
  return {
    used_percent: Math.max(0, Math.min(100, numPct)),
    resets_at,
  };
}

export function parseAnthropicOAuthUsagePayload(
  payload: unknown,
): ClaudeAccountUsage {
  if (!payload || typeof payload !== "object") {
    return emptyClaudeAccountUsage();
  }
  const obj = payload as Record<string, unknown>;

  let five_hour = parseWindowNode(obj.five_hour ?? obj.fiveHour);
  let seven_day = parseWindowNode(obj.seven_day ?? obj.sevenDay);
  let fable_weekly = parseWindowNode(
    obj.seven_day_fable ??
      obj.sevenDayFable ??
      obj.fable_weekly ??
      obj.fableWeekly,
  );

  if (Array.isArray(obj.limits)) {
    for (const item of obj.limits) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const limitObj = item as Record<string, unknown>;
      const type = String(limitObj.type ?? limitObj.window ?? "").toLowerCase();
      const scope = String(limitObj.scope ?? limitObj.key ?? "").toLowerCase();
      const modelObj =
        limitObj.model && typeof limitObj.model === "object"
          ? (limitObj.model as Record<string, unknown>)
          : null;
      const modelId = String(modelObj?.id ?? "").toLowerCase();
      const modelName = String(modelObj?.display_name ?? modelObj?.name ?? "").toLowerCase();

      const parsedWindow = parseWindowNode(limitObj);
      if (!parsedWindow) {
        continue;
      }

      if (
        !fable_weekly &&
        (type.includes("fable") ||
          scope.includes("fable") ||
          modelId.includes("fable") ||
          modelName.includes("fable"))
      ) {
        fable_weekly = parsedWindow;
      } else if (!five_hour && (type === "five_hour" || type === "5h" || scope === "five_hour")) {
        five_hour = parsedWindow;
      } else if (
        !seven_day &&
        (type === "seven_day" || type === "weekly" || type === "7d" || scope === "seven_day")
      ) {
        seven_day = parsedWindow;
      }
    }
  }

  return {
    five_hour,
    seven_day,
    fable_weekly,
  };
}

export interface CachedAccountObservation {
  auth_state: Extract<ClaudeAccountAuthState, "ok" | "idle">;
  stale: boolean;
  observed_at: string | null;
  usage: ClaudeAccountUsage;
  lastPolledAtMs: number;
}

export interface ClaudeAccountUsageCollectorOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  endpointUrl?: string;
  pollTtlMs?: number;
  concurrency?: number;
  perAccountTimeoutMs?: number;
}

export interface CollectAccountUsageInput {
  accountId: string;
  profileDir: string;
}

export interface CollectAccountUsageOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

export class ClaudeAccountUsageCollector {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly endpointUrl: string;
  private readonly pollTtlMs: number;
  private readonly concurrency: number;
  private readonly perAccountTimeoutMs: number;
  private readonly cache = new Map<string, CachedAccountObservation>();

  constructor(options: ClaudeAccountUsageCollectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.endpointUrl = options.endpointUrl ?? DEFAULT_USAGE_ENDPOINT;
    this.pollTtlMs = options.pollTtlMs ?? DEFAULT_POLL_TTL_MS;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.perAccountTimeoutMs = options.perAccountTimeoutMs ?? DEFAULT_PER_ACCOUNT_TIMEOUT_MS;
  }

  getCachedObservation(
    accountId: string,
    profileDir: string,
  ): CachedAccountObservation {
    const nowMs = this.now();
    const creds = readProfileCredentialsReadOnly(profileDir);
    if (!creds || (creds.expiresAtMs !== null && creds.expiresAtMs <= nowMs)) {
      const idleObs: CachedAccountObservation = {
        auth_state: "idle",
        stale: false,
        observed_at: null,
        usage: emptyClaudeAccountUsage(),
        lastPolledAtMs: nowMs,
      };
      this.cache.set(accountId, idleObs);
      return idleObs;
    }

    const existing = this.cache.get(accountId);
    if (existing) {
      return existing;
    }

    return {
      auth_state: "idle",
      stale: false,
      observed_at: null,
      usage: emptyClaudeAccountUsage(),
      lastPolledAtMs: 0,
    };
  }

  deleteCachedAccount(accountId: string): void {
    this.cache.delete(accountId);
  }

  async collectAll(
    inputs: CollectAccountUsageInput[],
    options: CollectAccountUsageOptions = {},
  ): Promise<Map<string, CachedAccountObservation>> {
    const results = new Map<string, CachedAccountObservation>();
    const toFetch: Array<{ input: CollectAccountUsageInput; accessToken: string }> = [];
    const nowMs = this.now();

    for (const input of inputs) {
      const creds = readProfileCredentialsReadOnly(input.profileDir);
      if (!creds || (creds.expiresAtMs !== null && creds.expiresAtMs <= nowMs)) {
        const idleObs: CachedAccountObservation = {
          auth_state: "idle",
          stale: false,
          observed_at: null,
          usage: emptyClaudeAccountUsage(),
          lastPolledAtMs: nowMs,
        };
        this.cache.set(input.accountId, idleObs);
        results.set(input.accountId, idleObs);
        continue;
      }

      const cached = this.cache.get(input.accountId);
      const isFreshCache =
        !options.forceRefresh &&
        cached !== undefined &&
        cached.lastPolledAtMs > 0 &&
        !cached.stale &&
        nowMs - cached.lastPolledAtMs < this.pollTtlMs;

      if (isFreshCache && cached) {
        results.set(input.accountId, cached);
        continue;
      }

      toFetch.push({ input, accessToken: creds.accessToken });
    }

    if (toFetch.length === 0) {
      return results;
    }

    let cursor = 0;
    const workerCount = Math.min(this.concurrency, toFetch.length);

    const runWorker = async (): Promise<void> => {
      while (cursor < toFetch.length) {
        const idx = cursor++;
        const item = toFetch[idx];
        if (!item) {
          break;
        }
        const obs = await this.fetchSingleAccountUsage(
          item.input.accountId,
          item.accessToken,
          options,
        );
        this.cache.set(item.input.accountId, obs);
        results.set(item.input.accountId, obs);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  private async fetchSingleAccountUsage(
    accountId: string,
    accessToken: string,
    options: CollectAccountUsageOptions,
  ): Promise<CachedAccountObservation> {
    const previous = this.cache.get(accountId);
    const nowMs = this.now();

    if (options.signal?.aborted) {
      return this.buildTransientFallback(previous, nowMs);
    }

    const remainingDeadlineMs =
      options.deadlineAtMs !== undefined
        ? options.deadlineAtMs - nowMs
        : this.perAccountTimeoutMs;

    if (remainingDeadlineMs <= 0) {
      return this.buildTransientFallback(previous, nowMs);
    }

    const timeoutMs = Math.min(this.perAccountTimeoutMs, remainingDeadlineMs);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpointUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          Accept: "application/json",
          "User-Agent": "soulstream-claude-account-pool/1.0",
        },
        signal: controller.signal,
      });

      const completedAtMs = this.now();

      if (response.status === 401 || response.status === 403) {
        // Single 401/403 must not permanently mark needs_relogin; treat as idle until CLI refresh confirms relogin need
        return {
          auth_state: "idle",
          stale: false,
          observed_at: null,
          usage: emptyClaudeAccountUsage(),
          lastPolledAtMs: completedAtMs,
        };
      }

      if (!response.ok) {
        return this.buildTransientFallback(previous, completedAtMs);
      }

      const body = (await response.json()) as unknown;
      const usage = parseAnthropicOAuthUsagePayload(body);

      return {
        auth_state: "ok",
        stale: false,
        observed_at: new Date(completedAtMs).toISOString(),
        usage,
        lastPolledAtMs: completedAtMs,
      };
    } catch {
      return this.buildTransientFallback(previous, this.now());
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private buildTransientFallback(
    previous: CachedAccountObservation | undefined,
    nowMs: number,
  ): CachedAccountObservation {
    if (previous && previous.observed_at !== null) {
      return {
        auth_state: previous.auth_state,
        stale: true,
        observed_at: previous.observed_at,
        usage: previous.usage,
        lastPolledAtMs: nowMs,
      };
    }
    return {
      auth_state: "idle",
      stale: true,
      observed_at: null,
      usage: emptyClaudeAccountUsage(),
      lastPolledAtMs: nowMs,
    };
  }
}
