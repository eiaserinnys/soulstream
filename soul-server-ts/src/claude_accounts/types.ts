export type ClaudeAccountAuthState = "ok" | "idle" | "logging_in" | "needs_relogin";

export type ClaudeAccountScope = "all" | "fable";

export interface ClaudeUsageWindow {
  used_percent: number;
  resets_at: string | null;
}

export interface ClaudeAccountUsage {
  five_hour: ClaudeUsageWindow | null;
  seven_day: ClaudeUsageWindow | null;
  fable_weekly: ClaudeUsageWindow | null;
}

export interface ClaudeAccountBlockView {
  until: string | null;
  scope: ClaudeAccountScope;
}

export interface ClaudeAccountRecord {
  id: string;
  email: string;
  plan: string;
  enabled: boolean;
  priority: number | null;
  created_at: string;
}

export interface ClaudeAccountView {
  id: string;
  email: string;
  plan: string;
  enabled: boolean;
  priority: number | null;
  auth_state: ClaudeAccountAuthState;
  active_sessions: number;
  blocked: ClaudeAccountBlockView | null;
  stale: boolean;
  observed_at: string | null;
  usage: ClaudeAccountUsage;
}

export interface ClaudeAccountPoolSummary {
  total_count: number;
  available_count: number;
  best_weekly_remaining_percent: number | null;
  best_weekly_resets_at: string | null;
  earliest_available_at: string | null;
}

export interface ClaudeAccountList {
  mode: "pool" | "legacy";
  accounts: ClaudeAccountView[];
  pool: ClaudeAccountPoolSummary;
  fable_pool: ClaudeAccountPoolSummary | null;
}

export interface ClaudeScopeBlockEntry {
  resets_at: string | null;
  observed_at: string;
}

export interface ClaudeAccountBlocksRecord {
  all?: ClaudeScopeBlockEntry;
  fable?: ClaudeScopeBlockEntry;
}

export interface ClaudeAccountsJsonFile {
  version: 1;
  accounts: ClaudeAccountRecord[];
}

export interface ClaudeBindingsJsonFile {
  version: 1;
  bindings: Record<string, string>;
}

export interface ClaudeBlocksJsonFile {
  version: 1;
  blocks: Record<string, ClaudeAccountBlocksRecord>;
}

export interface ClaudeAccountSelectionInput {
  session_id: string;
  turn_id: string;
  model: string;
  exclude_ids?: string[];
}

export interface ClaudeAccountSelectionResult {
  account_id: string;
  config_dir: string;
}

export interface ClaudeAccountRejectInput {
  account_id: string;
  scope: ClaudeAccountScope;
  resets_at: string | null;
  observed_at: string;
  session_id?: string;
}

export interface ClaudeAccountReleaseInput {
  session_id: string;
}

export interface ClaudeAccountUpdatePatch {
  enabled?: boolean;
  priority?: number | null;
}

export interface ClaudeAccountDeleteResult {
  id: string;
  deleted: boolean;
  deferred: boolean;
  accounts: ClaudeAccountView[];
  pool: ClaudeAccountPoolSummary;
  fable_pool: ClaudeAccountPoolSummary | null;
}

export interface ClaudeLoginAccountPort {
  createPendingDir(loginId: string): Promise<string>;
  profileDir(accountId: string): string;
  findAccount(accountId: string): Promise<ClaudeAccountRecord | null>;
  findByIdentity(identity: {
    accountUuid: string;
    email?: string | null;
  }): Promise<ClaudeAccountRecord | null>;
  registerFromPending(params: {
    loginId: string;
    accountUuid: string;
    email: string;
    plan: string;
    overwriteAccountId?: string;
  }): Promise<ClaudeAccountRecord>;
  retirePending(loginId: string): Promise<void>;
  beginRelogin(accountId: string): Promise<void>;
  endRelogin(
    accountId: string,
    outcome: "ok" | "needs_relogin" | "cancelled",
  ): Promise<void>;
  activeSessions(accountId: string): number;
}
