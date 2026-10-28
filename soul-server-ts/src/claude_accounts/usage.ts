import * as fs from "node:fs";
import * as path from "node:path";
import { claudeLimitsFromUsageResponse } from "../auth/provider_usage.js";
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
    obj.percent ??
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

function findScopedFableWindow(obj: Record<string, unknown>): ClaudeUsageWindow | null {
  if (!Array.isArray(obj.limits)) return null;
  for (const item of obj.limits) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const scope =
      entry.scope && typeof entry.scope === "object"
        ? (entry.scope as Record<string, unknown>)
        : null;
    const scopeModel =
      scope?.model && typeof scope.model === "object"
        ? (scope.model as Record<string, unknown>)
        : null;
    const directModel =
      entry.model && typeof entry.model === "object"
        ? (entry.model as Record<string, unknown>)
        : null;
    const label = String(
      scopeModel?.display_name ??
        scopeModel?.id ??
        directModel?.display_name ??
        directModel?.name ??
        directModel?.id ??
        entry.type ??
        entry.scope ??
        "",
    ).toLowerCase();
    if (label.includes("fable")) {
      const parsed = parseWindowNode(entry);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function parseAnthropicOAuthUsagePayload(
  payload: unknown,
): ClaudeAccountUsage {
  if (!payload || typeof payload !== "object") {
    return emptyClaudeAccountUsage();
  }
  const obj = payload as Record<string, unknown>;
  const normalized = claudeLimitsFromUsageResponse(obj);

  const rawFiveHour = parseWindowNode(obj.five_hour ?? obj.fiveHour);
  const rawSevenDay = parseWindowNode(obj.seven_day ?? obj.sevenDay);
  const rawFableDirect =
    parseWindowNode(
      obj.seven_day_fable ?? obj.sevenDayFable ?? obj.fable_weekly ?? obj.fableWeekly,
    ) ?? findScopedFableWindow(obj);

  const fiveHourQuota = normalized.quotas.find((q) => q.id === "claude:five_hour");
  const sevenDayQuota = normalized.quotas.find((q) => q.id === "claude:seven_day");
  const fableQuota = normalized.quotas.find(
    (q) =>
      q.id === "claude:weekly_scoped:fable" ||
      q.id === "claude:seven_day_fable" ||
      q.model?.toLowerCase() === "fable",
  );

  const five_hour: ClaudeUsageWindow | null =
    fiveHourQuota && fiveHourQuota.usedPercent !== null
      ? {
          used_percent: fiveHourQuota.usedPercent,
          resets_at:
            rawFiveHour?.resets_at ??
            (fiveHourQuota.resetAt !== null
              ? new Date(fiveHourQuota.resetAt * 1000).toISOString()
              : null),
        }
      : rawFiveHour;

  const seven_day: ClaudeUsageWindow | null =
    sevenDayQuota && sevenDayQuota.usedPercent !== null
      ? {
          used_percent: sevenDayQuota.usedPercent,
          resets_at:
            rawSevenDay?.resets_at ??
            (sevenDayQuota.resetAt !== null
              ? new Date(sevenDayQuota.resetAt * 1000).toISOString()
              : null),
        }
      : rawSevenDay;

  const fable_weekly: ClaudeUsageWindow | null =
    fableQuota && fableQuota.usedPercent !== null
      ? {
          used_percent: fableQuota.usedPercent,
          resets_at:
            rawFableDirect?.resets_at ??
            (fableQuota.resetAt !== null
              ? new Date(fableQuota.resetAt * 1000).toISOString()
              : null),
        }
      : rawFableDirect;

  return { five_hour, seven_day, fable_weekly };
}

function raceWithAbort<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
        ? options.deadlineAtMs - Date.now()
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
      const response = await raceWithAbort(
        controller.signal,
        this.fetchImpl(this.endpointUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
            "User-Agent": "soulstream-claude-account-pool/1.0",
          },
          signal: controller.signal,
        }),
      );

      const completedAtMs = this.now();

      if (response.status === 401 || response.status === 403) {
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

      const body = (await raceWithAbort(
        controller.signal,
        response.json(),
      )) as unknown;
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
