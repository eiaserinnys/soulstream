import type {
  NodeGitCloneJob,
  NodeGitError,
  NodeGitSetupSnapshot,
  NodeGitSshCheckResult,
} from "../../../packages/wire-schema/generated/typescript/index";
import { isRecord } from "../../../packages/wire-schema/src/json_record";

export type NodeGitField = NonNullable<NodeGitError["field"]>;

/** 오케스트레이터가 돌려준 {code, message, field?} 오류. 화면 문구는 nodeGitErrorText가 code로 고른다. */
export class NodeGitRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field: NodeGitField | null,
  ) {
    super(`Git 요청에 실패했습니다 (${status} ${code})`);
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

const FIELD_TEXT: Record<NodeGitField, string> = {
  name: "이름을 확인하세요.",
  email: "이메일 주소를 확인하세요.",
  host: "호스트 이름을 확인하세요.",
  url: "원격 주소를 확인하세요.",
  repo_name: "폴더 이름을 확인하세요.",
};

const CODE_TEXT: Record<string, string> = {
  node_not_connected: "노드가 연결되어 있지 않습니다.",
  node_git_unsupported: "이 노드를 업데이트하면 쓸 수 있습니다.",
  node_command_timeout: "노드가 제때 응답하지 않았습니다.",
  node_command_failed: "노드에 요청을 보내지 못했습니다.",
  node_command_rejected: "노드가 요청을 거절했습니다.",
  ssh_key_exists: "이 노드에는 이미 SSH 키가 있습니다.",
  ssh_key_create_failed: "SSH 키를 만들지 못했습니다.",
  ssh_not_installed: "이 노드에 ssh가 설치되어 있지 않습니다.",
  git_not_installed: "이 노드에 git이 설치되어 있지 않습니다.",
  repo_exists: "같은 이름의 폴더가 이미 있습니다.",
  clone_busy: "다른 저장소를 가져오는 중입니다.",
  clone_not_found: "가져오기 작업을 찾을 수 없습니다.",
  projects_root_unavailable: "이 노드의 저장소 폴더를 쓸 수 없습니다.",
  clone_timeout: "시간이 너무 오래 걸려 가져오기를 멈췄습니다.",
  auth_failed: "인증에 실패했습니다.",
  repo_not_found: "저장소를 찾을 수 없습니다.",
  unreachable: "저장소 서버에 닿지 못했습니다.",
  clone_failed: "저장소를 가져오지 못했습니다.",
};

export const SSH_CHECK_REASON_TEXT: Record<Exclude<NodeGitSshCheckResult["reason"], "connected">, string> = {
  auth_failed: "공개키가 저장소 서비스에 등록되어 있지 않습니다.",
  unreachable: "호스트에 닿지 못했습니다.",
  host_key_mismatch: "호스트 키가 이전과 다릅니다.",
  failed: "연결을 확인하지 못했습니다.",
};

/** 요청 오류와 클론 작업 오류를 화면 문구로 옮긴다. 입력 칸 오류는 칸 이름을 붙여 말한다. */
export function nodeGitErrorText(error: { code: string; field?: NodeGitField | null }): string {
  if (error.code === "invalid_request" && error.field) return FIELD_TEXT[error.field];
  return CODE_TEXT[error.code] ?? "Git 요청에 실패했습니다.";
}

/** 요청이 던진 값을 화면이 보일 오류로 바꾼다. 응답을 받지 못한 경우(네트워크)도 같은 모양이다. */
export function nodeGitRequestErrorOf(error: unknown): NodeGitRequestError {
  return error instanceof NodeGitRequestError ? error : new NodeGitRequestError(0, "node_command_failed", null);
}
