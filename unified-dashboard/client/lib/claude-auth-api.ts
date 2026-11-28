import type { useTranslation } from "react-i18next";
import type {
  ClaudeAccountList,
  ClaudeAccount,
  ClaudeAuthError,
  ClaudeAuthLoginFlow,
} from "../../../packages/wire-schema/generated/typescript/index";
import type { ClaudeCentralSettings } from "@seosoyoung/soul-ui";
import { isRecord } from "../../../packages/wire-schema/src/json_record";

export type ClaudeAccountPatch = {
  enabled?: boolean;
  priority?: number | null;
};

/**
 * 같은 풀 줄이 그리는 대상. 노드는 그 노드의 계정 API를, 중앙은 오케스트레이터의
 * 중앙 풀 API를 쓴다. 경로 문자열을 만드는 곳은 이 파일 하나뿐이다.
 */
export type ClaudeAccountTarget =
  | { readonly scope: "node"; readonly nodeId: string }
  | { readonly scope: "central" };

export const CENTRAL_CLAUDE_TARGET: ClaudeAccountTarget = { scope: "central" };

export function nodeClaudeTarget(nodeId: string): ClaudeAccountTarget {
  return { scope: "node", nodeId };
}

export class ClaudeAuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiError: ClaudeAuthError | null,
    readonly invalidResponse = false,
  ) {
    super(message);
    this.name = "ClaudeAuthRequestError";
  }
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
      apiError?.message || `HTTP ${response.status}`,
      response.status,
      apiError,
    );
  }

  if (!isRecord(payload)) {
    throw new ClaudeAuthRequestError("Invalid Claude account response", response.status, null, true);
  }
  return payload as T;
}

export function claudeAccountsPath(target: ClaudeAccountTarget): string {
  return target.scope === "central"
    ? "/api/claude-auth/central/accounts"
    : `/api/nodes/${encodeURIComponent(target.nodeId)}/claude-auth/accounts`;
}

export function claudeLoginsPath(target: ClaudeAccountTarget): string {
  return target.scope === "central"
    ? "/api/claude-auth/central/logins"
    : `/api/nodes/${encodeURIComponent(target.nodeId)}/claude-auth/logins`;
}

export function claudeCentralSettingsPath(): string {
  return "/api/claude-auth/central/settings";
}

export async function getClaudeAccounts(
  request: typeof fetch,
  target: ClaudeAccountTarget,
): Promise<ClaudeAccountList> {
  return requestClaudeAuthData<ClaudeAccountList>(request, claudeAccountsPath(target));
}

export async function getClaudeCentralSettings(
  request: typeof fetch,
): Promise<ClaudeCentralSettings> {
  return requestClaudeAuthData<ClaudeCentralSettings>(request, claudeCentralSettingsPath());
}

/** 응답은 그 노드가 새 설정을 이미 받은 상태이므로 그대로 화면 값으로 쓴다. */
export async function putClaudeCentralReceive(
  request: typeof fetch,
  nodeId: string,
  receive: boolean,
): Promise<ClaudeCentralSettings> {
  return requestClaudeAuthData<ClaudeCentralSettings>(request, claudeCentralSettingsPath(), {
    method: "PUT",
    body: { nodes: { [nodeId]: receive } },
  });
}

export function accountPath(target: ClaudeAccountTarget, accountId: string): string {
  return `${claudeAccountsPath(target)}/${encodeURIComponent(accountId)}`;
}

export function loginPath(target: ClaudeAccountTarget, loginId: string): string {
  return `${claudeLoginsPath(target)}/${encodeURIComponent(loginId)}`;
}

export async function cancelClaudeAccountLogin(
  request: typeof fetch,
  target: ClaudeAccountTarget,
  loginId: string,
): Promise<ClaudeAuthLoginFlow> {
  return requestClaudeAuthData<ClaudeAuthLoginFlow>(request, loginPath(target, loginId), { method: "DELETE" });
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

export function claudeAuthErrorMessage(error: ClaudeAuthError | null | undefined, t: ReturnType<typeof useTranslation>["t"]): string {
  if (!error) return t("accounts.claude.authFailed");
  if (error.code === "account_exists") return t("accounts.claude.accountExists");
  if (error.code === "account_identity_mismatch") return t("accounts.claude.identityMismatch");
  return error.message || t("accounts.claude.authFailed");
}

export function requestErrorMessage(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error instanceof ClaudeAuthRequestError) {
    if (error.apiError) return claudeAuthErrorMessage(error.apiError, t);
    if (error.invalidResponse) return t("accounts.claude.invalidResponse");
    return t("accounts.claude.requestStatus", { value: error.status });
  }
  return error instanceof Error ? error.message : t("accounts.claude.requestFailed");
}
