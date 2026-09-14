import type { SqlClient } from "../control_plane/control_plane_types.js";

export const SESSION_REVIEW_POLICY_KEY = "session_review_policy";
export const QUALIFIED_BROWSER_SOURCE = "browser";

export type SessionReviewDecision = {
  reviewRequired: boolean;
  reviewState: "not_required";
};

export type SessionReviewPolicy = {
  key: typeof SESSION_REVIEW_POLICY_KEY;
  sourceAllowlist: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
};

export type SessionReviewPolicySource = {
  source: string;
  label: string;
  description: string;
  automatic: boolean;
};

export const SESSION_REVIEW_POLICY_SOURCE_CATALOG: readonly SessionReviewPolicySource[] = [
  {
    source: "slack",
    label: "Slack",
    description: "Slack 사용자가 직접 시작한 요청",
    automatic: false,
  },
  {
    source: "soul-app",
    label: "Soul 앱",
    description: "Soul 모바일 앱에서 직접 시작한 요청",
    automatic: false,
  },
  {
    source: "external-llm",
    label: "외부 LLM",
    description: "외부 LLM에서 직접 시작한 요청",
    automatic: false,
  },
  {
    source: "clipper",
    label: "Clipper",
    description: "Clipper에서 명시적으로 생성한 요청",
    automatic: false,
  },
  {
    source: "llm",
    label: "공개 연동",
    description: "공개 연동을 통해 시작한 요청",
    automatic: true,
  },
  {
    source: "agent",
    label: "내부 에이전트",
    description: "다른 에이전트가 시작한 요청",
    automatic: true,
  },
  {
    source: "system",
    label: "시스템",
    description: "서비스가 자동으로 시작한 요청",
    automatic: true,
  },
  {
    source: "cron",
    label: "예약 작업",
    description: "예약 일정에 따라 시작한 요청",
    automatic: true,
  },
  {
    source: "channel_observer",
    label: "채널 관찰자",
    description: "채널 활동에 따라 자동으로 시작한 요청",
    automatic: true,
  },
] as const;

type SessionReviewPolicyRow = {
  setting_key: unknown;
  value: unknown;
  version: unknown;
  updated_at: unknown;
  updated_by: unknown;
};

export class SessionReviewPolicyError extends Error {
  constructor(
    readonly code: "SESSION_REVIEW_POLICY_UNAVAILABLE" | "SESSION_REVIEW_POLICY_INVALID" | "SESSION_REVIEW_POLICY_CONFLICT",
    message: string,
    readonly statusCode: 409 | 422 | 503,
  ) {
    super(message);
    this.name = "SessionReviewPolicyError";
  }
}

export async function readSessionReviewPolicy(
  sql: SqlClient,
  options: { lock?: "share" } = {},
): Promise<SessionReviewPolicy> {
  let rows: SessionReviewPolicyRow[];
  try {
    rows = options.lock === "share"
      ? await sql<SessionReviewPolicyRow[]>`
          SELECT setting_key, value, version, updated_at, updated_by
          FROM system_settings
          WHERE setting_key = ${SESSION_REVIEW_POLICY_KEY}
          FOR SHARE
        `
      : await sql<SessionReviewPolicyRow[]>`
          SELECT setting_key, value, version, updated_at, updated_by
          FROM system_settings
          WHERE setting_key = ${SESSION_REVIEW_POLICY_KEY}
        `;
  } catch (error) {
    if (postgresErrorCode(error) === "42P01") {
      throw unavailablePolicy(
        "Session review policy storage is unavailable. Apply database migration 091_system_settings.sql before deploying the new worker.",
      );
    }
    throw error;
  }
  if (rows[0] === undefined) {
    throw unavailablePolicy(
      "Session review policy is missing. Restore the session_review_policy seed before creating new sessions.",
    );
  }
  return parseSessionReviewPolicyRow(rows[0]);
}

export async function updateSessionReviewPolicy(
  sql: SqlClient,
  input: {
    sourceAllowlist: readonly unknown[];
    expectedVersion: number;
    updatedBy: string;
  },
): Promise<SessionReviewPolicy> {
  const sourceAllowlist = normalizeSessionReviewSourceAllowlist(input.sourceAllowlist);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new SessionReviewPolicyError(
      "SESSION_REVIEW_POLICY_INVALID",
      "expectedVersion must be a positive integer",
      422,
    );
  }
  const updatedBy = input.updatedBy.trim().toLowerCase();
  if (!updatedBy) {
    throw new SessionReviewPolicyError(
      "SESSION_REVIEW_POLICY_INVALID",
      "updatedBy is required",
      422,
    );
  }

  let rows: SessionReviewPolicyRow[];
  try {
    rows = await sql<SessionReviewPolicyRow[]>`
      UPDATE system_settings
      SET value = ${sql.json({ source_allowlist: sourceAllowlist })},
          version = version + 1,
          updated_at = NOW(),
          updated_by = ${updatedBy}
      WHERE setting_key = ${SESSION_REVIEW_POLICY_KEY}
        AND version = ${input.expectedVersion}
      RETURNING setting_key, value, version, updated_at, updated_by
    `;
  } catch (error) {
    if (postgresErrorCode(error) === "42P01") {
      throw unavailablePolicy(
        "Session review policy storage is unavailable. Apply database migration 091_system_settings.sql before editing this setting.",
      );
    }
    throw error;
  }
  if (rows[0] !== undefined) return parseSessionReviewPolicyRow(rows[0]);

  let current: SessionReviewPolicy;
  try {
    current = await readSessionReviewPolicy(sql);
  } catch (error) {
    if (error instanceof SessionReviewPolicyError) throw error;
    throw error;
  }
  throw new SessionReviewPolicyError(
    "SESSION_REVIEW_POLICY_CONFLICT",
    `Session review policy changed from version ${input.expectedVersion} to ${current.version}. Reload before saving.`,
    409,
  );
}

export function normalizeSessionReviewSourceAllowlist(
  raw: readonly unknown[],
): string[] {
  if (!Array.isArray(raw)) {
    throw invalidPolicy("sourceAllowlist must be an array");
  }
  if (raw.length > 64) {
    throw invalidPolicy("sourceAllowlist may contain at most 64 sources");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      throw invalidPolicy("Every source must be a string");
    }
    const source = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source)) {
      throw invalidPolicy(
        `Invalid source "${source || "(empty)"}". Use 1-64 lowercase letters, numbers, hyphens, or underscores.`,
      );
    }
    if (source === QUALIFIED_BROWSER_SOURCE) {
      throw invalidPolicy(
        "browser is identity-qualified automatically and cannot be added to sourceAllowlist",
      );
    }
    if (seen.has(source)) continue;
    seen.add(source);
    normalized.push(source);
  }
  return normalized;
}

export function evaluateInitialSessionReview(
  callerInfo: Record<string, unknown> | null | undefined,
  policy: Pick<SessionReviewPolicy, "sourceAllowlist">,
): SessionReviewDecision {
  const source = nonEmptyString(callerInfo?.source);
  const reviewRequired = source === QUALIFIED_BROWSER_SOURCE
    ? hasQualifiedBrowserIdentity(callerInfo)
    : source !== undefined && policy.sourceAllowlist.includes(source);
  return {
    reviewRequired,
    reviewState: "not_required",
  };
}

export function sessionReviewPolicyApiPayload(policy: SessionReviewPolicy) {
  return {
    policy,
    conditionalRules: [{
      source: QUALIFIED_BROWSER_SOURCE,
      label: "로그인한 브라우저 요청",
      description: "로그인한 브라우저 요청은 항상 검수합니다.",
      condition: "identified_user",
    }],
    sourceCatalog: SESSION_REVIEW_POLICY_SOURCE_CATALOG,
  };
}

function parseSessionReviewPolicyRow(row: SessionReviewPolicyRow): SessionReviewPolicy {
  try {
    if (row.setting_key !== SESSION_REVIEW_POLICY_KEY) {
      throw new Error("unexpected setting_key");
    }
    if (!isRecord(row.value) || !Array.isArray(row.value.source_allowlist)) {
      throw new Error("value.source_allowlist must be an array");
    }
    const sourceAllowlist = normalizeSessionReviewSourceAllowlist(row.value.source_allowlist);
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("version must be a positive integer");
    }
    const updatedAt = timestampString(row.updated_at);
    const updatedBy = nonEmptyString(row.updated_by);
    if (!updatedBy) throw new Error("updated_by is required");
    return {
      key: SESSION_REVIEW_POLICY_KEY,
      sourceAllowlist,
      version,
      updatedAt,
      updatedBy,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionReviewPolicyError(
      "SESSION_REVIEW_POLICY_UNAVAILABLE",
      `Stored session review policy is corrupt: ${detail}. Repair the session_review_policy row before creating new sessions.`,
      503,
    );
  }
}

function hasQualifiedBrowserIdentity(
  callerInfo: Record<string, unknown> | null | undefined,
): boolean {
  return [
    callerInfo?.user_id,
    callerInfo?.userId,
    callerInfo?.email,
    callerInfo?.display_name,
    callerInfo?.displayName,
  ].some((value) => nonEmptyString(value) !== undefined);
}

function invalidPolicy(message: string): SessionReviewPolicyError {
  return new SessionReviewPolicyError(
    "SESSION_REVIEW_POLICY_INVALID",
    message,
    422,
  );
}

function unavailablePolicy(message: string): SessionReviewPolicyError {
  return new SessionReviewPolicyError(
    "SESSION_REVIEW_POLICY_UNAVAILABLE",
    message,
    503,
  );
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error("updated_at must be a timestamp");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
