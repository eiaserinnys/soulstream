import type { useTranslation } from "react-i18next";
import type {
  NodeGitCloneJob,
  NodeGitError,
  NodeGitSetupSnapshot,
  NodeGitSshCheckResult,
} from "../../../packages/wire-schema/generated/typescript/index";
import { isRecord } from "../../../packages/wire-schema/src/json_record";

type Translate = ReturnType<typeof useTranslation>["t"];

export type NodeGitField = NonNullable<NodeGitError["field"]>;

/** 오케스트레이터가 돌려준 {code, message, field?} 오류. 화면 문구는 nodeGitErrorText가 code로 고른다. */
export class NodeGitRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field: NodeGitField | null,
  ) {
    super(`HTTP ${status} ${code}`);
    this.name = "NodeGitRequestError";
  }
}

const FIELDS: readonly string[] = ["name", "email", "host", "url", "repo_name"];

async function requestNodeGit<T>(
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
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "request_failed";
    const field = isRecord(payload) && typeof payload.field === "string" && FIELDS.includes(payload.field)
      ? payload.field as NodeGitField
      : null;
    throw new NodeGitRequestError(response.status, code, field);
  }
  if (!isRecord(payload)) throw new NodeGitRequestError(response.status, "invalid_response", null);
  return payload as T;
}

const gitPath = (nodeId: string) => `/api/nodes/${encodeURIComponent(nodeId)}/git`;

export const getNodeGit = (request: typeof fetch, nodeId: string) =>
  requestNodeGit<NodeGitSetupSnapshot>(request, gitPath(nodeId));

export const putNodeGitIdentity = (request: typeof fetch, nodeId: string, body: { name: string; email: string }) =>
  requestNodeGit<NodeGitSetupSnapshot>(request, `${gitPath(nodeId)}/identity`, { method: "PUT", body });

export const createNodeGitSshKey = (request: typeof fetch, nodeId: string) =>
  requestNodeGit<NodeGitSetupSnapshot>(request, `${gitPath(nodeId)}/ssh-key`, { method: "POST" });

export const checkNodeGitSsh = (request: typeof fetch, nodeId: string, host: string) =>
  requestNodeGit<NodeGitSshCheckResult>(request, `${gitPath(nodeId)}/ssh-check`, { method: "POST", body: { host } });

export const startNodeGitClone = (request: typeof fetch, nodeId: string, body: { url: string; repo_name?: string }) =>
  requestNodeGit<NodeGitCloneJob>(request, `${gitPath(nodeId)}/clones`, { method: "POST", body });

export const getNodeGitClone = (request: typeof fetch, nodeId: string, cloneId: string) =>
  requestNodeGit<NodeGitCloneJob>(request, `${gitPath(nodeId)}/clones/${encodeURIComponent(cloneId)}`);

const FIELD_KEY: Record<NodeGitField, string> = {
  name: "accounts.git.invalidName",
  email: "accounts.git.invalidEmail",
  host: "accounts.git.invalidHost",
  url: "accounts.git.invalidUrl",
  repo_name: "accounts.git.invalidRepoName",
};

const CODE_KEY: Record<string, string> = {
  node_not_connected: "accounts.git.offline",
  node_git_unsupported: "accounts.git.updateNode",
  node_command_timeout: "accounts.git.commandTimeout",
  node_command_failed: "accounts.git.commandFailed",
  node_command_rejected: "accounts.git.commandRejected",
  ssh_key_exists: "accounts.git.sshKeyExists",
  ssh_key_create_failed: "accounts.git.sshKeyCreateFailed",
  ssh_not_installed: "accounts.git.sshMissing",
  git_not_installed: "accounts.git.gitMissing",
  repo_exists: "accounts.git.repoExists",
  clone_busy: "accounts.git.cloneBusy",
  clone_not_found: "accounts.git.cloneNotFound",
  projects_root_unavailable: "accounts.git.rootUnavailable",
  clone_timeout: "accounts.git.cloneTimeout",
  auth_failed: "accounts.git.authFailed",
  repo_not_found: "accounts.git.repoNotFound",
  unreachable: "accounts.git.repoUnreachable",
  clone_failed: "accounts.git.cloneFailed",
};

const SSH_CHECK_REASON_KEY: Record<Exclude<NodeGitSshCheckResult["reason"], "connected">, string> = {
  auth_failed: "accounts.git.sshAuthFailed",
  unreachable: "accounts.git.hostUnreachable",
  host_key_mismatch: "accounts.git.hostKeyMismatch",
  failed: "accounts.git.sshCheckFailed",
};

/** 요청 오류와 클론 작업 오류를 화면 문구로 옮긴다. 입력 칸 오류는 칸 이름을 붙여 말한다. */
export function nodeGitErrorText(error: { code: string; field?: NodeGitField | null }, t: Translate): string {
  if (error.code === "invalid_request" && error.field && Object.hasOwn(FIELD_KEY, error.field)) {
    return t(FIELD_KEY[error.field]);
  }
  return t(Object.hasOwn(CODE_KEY, error.code) ? CODE_KEY[error.code] : "accounts.git.requestFailed");
}

/** 요청이 던진 값을 화면이 보일 오류로 바꾼다. 응답을 받지 못한 경우(네트워크)도 같은 모양이다. */
export function nodeGitRequestErrorOf(error: unknown): NodeGitRequestError {
  return error instanceof NodeGitRequestError ? error : new NodeGitRequestError(0, "node_command_failed", null);
}

export function nodeGitSshCheckErrorText(reason: NodeGitSshCheckResult["reason"], t: Translate): string {
  return t(reason === "connected" ? "accounts.git.sshCheckFailed" : SSH_CHECK_REASON_KEY[reason]);
}

export function nodeGitRequestDetail(error: unknown, t: Translate): string {
  if (error instanceof NodeGitRequestError) {
    return t("accounts.git.requestStatus", { status: error.status, code: error.code });
  }
  return error instanceof Error ? error.message : String(error);
}
