import type {
  ClaudeAccount,
  ClaudeAccountList,
  ClaudeAccountPool,
  ClaudeCentralPoolAccount,
} from "@soulstream/wire-schema";

export type ClaudeCentralAuthState = ClaudeCentralPoolAccount["auth_state"];

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

/** `/api/oauth/usage` 응답 본문과 관측 시각. 메모리에만 둔다. */
export type ClaudeCentralUsageObservation = {
  readonly raw: Record<string, unknown> | null;
  readonly fetched_at: string | null;
};

export type ClaudeCentralAccountView = Omit<
  ClaudeAccount,
  "source" | "priority" | "auth_state" | "blocked"
> & {
  priority: number;
  auth_state: ClaudeCentralAuthState;
  blocked: null;
};

export type ClaudeCentralAccountList = Omit<ClaudeAccountList, "mode" | "accounts" | "pool"> & {
  mode: "pool";
  accounts: ClaudeCentralAccountView[];
  pool: ClaudeAccountPool;
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

