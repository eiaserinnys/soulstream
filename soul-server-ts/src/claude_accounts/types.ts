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
  plan: string | null;
  enabled: boolean;
  priority: number | null;
  created_at: string;
}

export interface ClaudeAccountView {
  id: string;
  email: string;
  plan: string | null;
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

export interface ClaudeSessionBindingEntry {
  account_id: string;
  turn_id: string | null;
}

export interface ClaudeBindingsJsonFile {
  version: 1;
  bindings: Record<string, string | ClaudeSessionBindingEntry>;
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
  account_id?: string;
  /** Only clear the assignment if it still belongs to this turn. */
  turn_id?: string;
  /** The selected turn ended while the Query still owns this profile. */
  keep_query_active?: boolean;
  /** The session runtime closed after Query, background work, and child exit. */
  clear_all?: boolean;
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
  profileDir(accountId: string): string | null;
  findAccount(accountId: string): Promise<{ id: string; email: string | null } | null>;
  findByIdentity(input: { id: string; email: string | null }): Promise<{ id: string } | null>;
  registerFromPending(input: {
    loginId: string;
    id: string;
    email: string | null;
    plan: string | null;
  }): Promise<void>;
  retirePending(loginId: string): Promise<void>;
  beginRelogin(accountId: string): Promise<void>;
  endRelogin(accountId: string, outcome: "ok" | "needs_relogin"): Promise<void>;
  activeSessions(accountId: string): number;
}
