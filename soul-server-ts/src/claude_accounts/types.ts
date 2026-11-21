import type {
  ClaudeAccount,
  ClaudeAccountBlocked,
  ClaudeAccountDeleteResult as WireClaudeAccountDeleteResult,
  ClaudeAccountList as WireClaudeAccountList,
  ClaudeAccountPool,
  ClaudeCentralPoolSync,
} from "@soulstream/wire-schema";

export type ClaudeAccountAuthState = ClaudeAccount["auth_state"];

export type ClaudeAccountScope = ClaudeAccountBlocked["scope"];

export type ClaudeAccountSource = ClaudeAccount["source"];

export type ClaudeCentralPoolSyncPayload = Pick<
  ClaudeCentralPoolSync,
  "revision" | "receive" | "accounts"
>;

export interface ClaudeAccountRecord {
  id: string;
  email: string;
  plan: string | null;
  enabled: boolean;
  priority: number | null;
  created_at: string;
}

export type ClaudeAccountView = Omit<ClaudeAccount, "login_expires_at"> & {
  login_expires_at: string | null;
  stale: boolean;
};

export type ClaudeAccountList = Omit<WireClaudeAccountList, "accounts" | "pool"> & {
  accounts: ClaudeAccountView[];
  pool: ClaudeAccountPool;
};

export interface ClaudeScopeBlockEntry {
  resets_at: string | null;
  observed_at: string;
}

export interface ClaudeAccountBlocksRecord {
  all?: ClaudeScopeBlockEntry;
  fable?: ClaudeScopeBlockEntry;
}

export type ClaudeAccountReloginReason =
  | "renewal_failed"
  | "usage_rejected"
  | "session_auth_failed"
  | "login_failed";

export interface ClaudeAccountReloginRecord {
  reason: ClaudeAccountReloginReason;
  observed_at: string;
}

export interface ClaudeReloginJsonFile {
  version: 1;
  relogin: Record<string, ClaudeAccountReloginRecord>;
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

/** 같은 턴에서 이미 시도한 중앙 계정 자격. 계정 id와 토큰 지문으로 가른다. */
export interface ClaudeExcludedCredential {
  account_id: string;
  token_fingerprint: string;
}

export interface ClaudeAccountSelectionInput {
  session_id: string;
  turn_id: string;
  model: string;
  exclude_ids?: string[];
  /** 중앙 계정 후보에서 뺄 (계정 id, 토큰 지문) 쌍. 로컬 계정에는 쓰지 않는다. */
  exclude_credentials?: ClaudeExcludedCredential[];
}

/** restricted(격리) 선택 옵션. 러너 요청 필드가 아니라 호스트 내부에서만 쓴다. */
export interface ClaudeAccountSelectionOptions {
  requireAccessTokenCredential?: boolean;
}

export interface ClaudeAccountSelectionResult {
  account_id: string;
  config_dir: string;
  /** 중앙 계정을 골랐을 때만 붙는다. 없으면 노드 로컬 계정이다. */
  source?: ClaudeAccountSource;
  /** Accounts still assignable for this model after `exclude_ids` is applied. */
  available_count: number;
}

export interface ClaudeAccountSelectionExhausted {
  pool_exhausted: true;
  available_count: 0;
  earliest_available_at: string | null;
  /** 켜진 계정이 모두 needs_relogin이라 선택이 실패했을 때만 붙는다. */
  reason?: "needs_relogin";
}

/** restricted(격리) 선택 응답에만 붙는 접근 토큰. 호스트 내부 전달용이다. */
export interface ClaudeAccountAccessTokenCredential {
  kind: "access-token";
  access_token: string;
}

/**
 * restricted 선택 결과. 계정 목록·영속 바인딩에는 이 값을 넣지 않는다.
 * 호스트가 러너로 넘길 때만 쓴다.
 */
export type ClaudeAccountSelectionWithCredential = ClaudeAccountSelectionResult & {
  credential: ClaudeAccountAccessTokenCredential;
};

export type ClaudeAccountSelectionResponse =
  | ClaudeAccountSelectionResult
  | ClaudeAccountSelectionExhausted;

export interface ClaudeAccountRejectInput {
  account_id: string;
  scope: ClaudeAccountScope;
  resets_at: string | null;
  observed_at: string;
  session_id?: string;
}

export interface ClaudeAccountAuthFailureInput {
  account_id: string;
  session_id: string;
  observed_at: string;
  /** 중앙 계정에서 실패한 토큰의 sha256 지문. 없으면 지금 받은 토큰으로 계산한다. */
  token_fingerprint?: string;
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

export type ClaudeAccountDeleteResult = Omit<
  WireClaudeAccountDeleteResult,
  "accounts" | "pool"
> & {
  accounts: ClaudeAccountView[];
  pool: ClaudeAccountPool;
};

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
  beginRelogin(accountId: string, expiresAt: string): Promise<void>;
  endRelogin(accountId: string, outcome: "ok" | "needs_relogin"): Promise<void>;
  activeSessions(accountId: string): number;
}
