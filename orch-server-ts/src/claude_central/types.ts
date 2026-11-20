import type { ClaudeCentralPoolAccount } from "@soulstream/wire-schema";

export type ClaudeCentralAuthState = "ok" | "needs_relogin";

export type ClaudeCentralAccountRecord = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly enabled: boolean;
  readonly priority: number;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: string | null;
  readonly tokenLifetimeSec: number | null;
  readonly scopes: string | null;
  readonly authState: ClaudeCentralAuthState;
  readonly reloginReason: string | null;
  readonly refreshedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ClaudeCentralUsageWindow = {
  readonly used_percent: number;
  readonly resets_at: string | null;
};

export type ClaudeCentralUsage = {
  readonly five_hour: ClaudeCentralUsageWindow | null;
  readonly seven_day: ClaudeCentralUsageWindow | null;
  readonly fable_weekly: ClaudeCentralUsageWindow | null;
};

/** `/api/oauth/usage` 응답 본문과 관측 시각. 메모리에만 둔다. */
export type ClaudeCentralUsageObservation = {
  readonly raw: Record<string, unknown> | null;
  readonly fetched_at: string | null;
};

export type ClaudeCentralPoolSummary = {
  readonly total_count: number;
  readonly available_count: number;
  readonly best_weekly_remaining_percent: number | null;
  readonly best_weekly_resets_at: string | null;
  readonly earliest_available_at: string | null;
};

/**
 * 노드의 `claude_auth_accounts_list` 계정 항목과 같은 칸 이름을 쓴다.
 * 중앙 전용 칸(expires_at, refreshed_at, relogin_reason)만 더한다.
 */
export type ClaudeCentralAccountView = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly enabled: boolean;
  readonly priority: number;
  readonly auth_state: ClaudeCentralAuthState;
  readonly login_expires_at?: string;
  readonly usage: ClaudeCentralUsage;
  readonly observed_at: string | null;
  readonly blocked: null;
  readonly active_sessions: number;
  readonly expires_at: string | null;
  readonly refreshed_at: string | null;
  readonly relogin_reason: string | null;
};

export type ClaudeCentralAccountList = {
  readonly mode: "pool";
  readonly accounts: ClaudeCentralAccountView[];
  readonly pool: ClaudeCentralPoolSummary;
  readonly fable_pool: ClaudeCentralPoolSummary | null;
};

export type ClaudeCentralPoolSettings = {
  readonly default_receive: boolean;
  readonly nodes: Record<string, boolean>;
};

export type ClaudeCentralEffectiveNode = {
  readonly node_id: string;
  readonly receive: boolean;
  readonly connected: boolean;
};

export type ClaudeCentralSettingsView = {
  readonly default_receive: boolean;
  readonly nodes: Record<string, boolean>;
  readonly effective: ClaudeCentralEffectiveNode[];
};

/**
 * 오케스트레이터→노드 `claude_central_pool_sync` 계약(payload.accounts 항목).
 * wire-schema의 생성 타입과 같은 정의이므로 별칭만 둔다.
 */
export type ClaudeCentralPoolSyncAccount = ClaudeCentralPoolAccount;
