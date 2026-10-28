import type {
  ClaudeAccountDeleteResult,
  ClaudeAccountList,
  ClaudeAccount,
  ClaudeAuthError,
  ClaudeAuthLoginFlow,
} from "@seosoyoung/soul-ui";

export type ClaudeAccountPatch = {
  enabled?: boolean;
  priority?: number | null;
};

export class ClaudeAuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError: ClaudeAuthError | null,
  ) {
    super(message);
    this.name = "ClaudeAuthRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseApiError(value: unknown): ClaudeAuthError | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  return {
    code: value.code,
    message: typeof value.message === "string" ? value.message : "",
    ...(typeof value.existing_account_id === "string"
      ? { existing_account_id: value.existing_account_id }
      : {}),
  };
}

export async function requestClaudeAuthData<T>(
  request: typeof fetch,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await request(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const apiError = parseApiError(payload);
    throw new ClaudeAuthRequestError(
      apiError?.message || `Claude 계정 요청에 실패했습니다 (${response.status})`,
      response.status,
      apiError,
    );
  }

  if (!isRecord(payload)) {
    throw new ClaudeAuthRequestError("Claude 계정 응답 형식이 올바르지 않습니다.", response.status, null);
  }
  return payload as T;
}

export function claudeAccountsPath(nodeId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/accounts`;
}

export async function getClaudeAccounts(
  request: typeof fetch,
  nodeId: string,
): Promise<ClaudeAccountList> {
  return requestClaudeAuthData<ClaudeAccountList>(request, claudeAccountsPath(nodeId));
}

export function accountPath(nodeId: string, accountId: string): string {
  return `${claudeAccountsPath(nodeId)}/${encodeURIComponent(accountId)}`;
}

export function loginPath(nodeId: string, loginId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/claude-auth/logins/${encodeURIComponent(loginId)}`;
}

export function toAccountList(
  result: ClaudeAccountDeleteResult,
  current: ClaudeAccountList,
): ClaudeAccountList {
  return { ...current, accounts: result.accounts, pool: result.pool };
}

export function replaceAccount(
  current: ClaudeAccountList,
  accountId: string,
  update: (account: ClaudeAccount) => ClaudeAccount,
): ClaudeAccountList {
  return {
    ...current,
    accounts: current.accounts.map((account) => account.id === accountId ? update(account) : account),
  };
}

export function claudeAuthErrorMessage(error: ClaudeAuthError | null | undefined): string {
  if (!error) return "인증을 완료하지 못했습니다.";
  if (error.code === "account_exists") return "이미 등록된 계정입니다.";
  if (error.code === "account_identity_mismatch") return "인증한 계정이 기존 계정과 다릅니다. 기존 계정을 유지했습니다.";
  return error.message || "인증을 완료하지 못했습니다.";
}

export function requestErrorMessage(error: unknown): string {
  if (error instanceof ClaudeAuthRequestError && error.apiError) {
    return claudeAuthErrorMessage(error.apiError);
  }
  return error instanceof Error ? error.message : "Claude 계정 요청에 실패했습니다.";
}

export type { ClaudeAccountDeleteResult, ClaudeAccountList, ClaudeAuthError, ClaudeAuthLoginFlow };
