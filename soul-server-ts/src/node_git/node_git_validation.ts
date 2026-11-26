export type NodeGitField = "name" | "email" | "host" | "url" | "repo_name";

export class NodeGitServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: NodeGitField,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "NodeGitServiceError";
  }

  toWire(): { code: string; message: string; field?: NodeGitField; detail?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.field === undefined ? {} : { field: this.field }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}

const HOST_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST_PATTERN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const USER = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const URL_PATH = "[A-Za-z0-9._~][A-Za-z0-9._~/-]{0,511}";
const HTTPS_URL = new RegExp(`^https://([^/:@\\s]+)(?::(\\d{1,5}))?/(${URL_PATH})$`);
const SCP_URL = new RegExp(`^${USER}@([^/:@\\s]+):(${URL_PATH})$`);
const SSH_URL = new RegExp(`^ssh://(?:${USER}@)?([^/:@\\s]+)(?::(\\d{1,5}))?/(${URL_PATH})$`);
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CLONE_ID = /^[A-Za-z0-9-]{1,64}$/;
const EMAIL_LOCAL = /^[^\s<>@-][^\s<>@]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isHost(value: string): boolean {
  return value.length >= 1 && value.length <= 253 && HOST_PATTERN.test(value);
}

function requireText(value: unknown, field: NodeGitField): string {
  if (typeof value !== "string") {
    throw new NodeGitServiceError("invalid_request", `${field} must be a string`, field);
  }
  return value;
}

function isPort(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function parseIdentity(input: { name: unknown; email: unknown }): { name: string; email: string } {
  const name = requireText(input.name, "name").trim();
  if (name.length < 1 || name.length > 100 || CONTROL_CHARS.test(name) || /[<>]/.test(name) || name.startsWith("-")) {
    throw new NodeGitServiceError("invalid_request", "name is not a valid git user name", "name");
  }
  const email = requireText(input.email, "email");
  const at = email.lastIndexOf("@");
  const valid = email.length <= 254
    && at > 0
    && EMAIL_LOCAL.test(email.slice(0, at))
    && isHost(email.slice(at + 1));
  if (!valid) {
    throw new NodeGitServiceError("invalid_request", "email is not a valid address", "email");
  }
  return { name, email };
}

export function parseHost(value: unknown): string {
  const host = requireText(value, "host");
  if (!isHost(host)) {
    throw new NodeGitServiceError("invalid_request", "host is not a valid host name", "host");
  }
  return host;
}

/** 허용하는 세 형태(https, scp식, ssh)만 받아들이고 경로 조각을 돌려준다. */
function matchCloneUrl(url: string): { path: string } | null {
  if (url.length > 2048 || /\s/.test(url) || CONTROL_CHARS.test(url)) return null;
  const https = HTTPS_URL.exec(url);
  if (https) return isHost(https[1]!) && isPort(https[2]) ? { path: https[3]! } : null;
  const ssh = SSH_URL.exec(url);
  if (ssh) return isHost(ssh[1]!) && isPort(ssh[2]) ? { path: ssh[3]! } : null;
  const scp = SCP_URL.exec(url);
  return scp && isHost(scp[1]!) ? { path: scp[2]! } : null;
}

export function parseCloneUrl(value: unknown): string {
  const url = requireText(value, "url");
  if (!matchCloneUrl(url)) {
    throw new NodeGitServiceError("invalid_request", "url is not an allowed clone URL", "url");
  }
  return url;
}

export function parseRepoName(value: unknown): string {
  const name = requireText(value, "repo_name");
  if (!REPO_NAME.test(name) || name.includes("--") || name.endsWith(".") || name.endsWith(".git")) {
    throw new NodeGitServiceError("invalid_request", "repo_name is not a valid folder name", "repo_name");
  }
  return name;
}

/** 검증을 통과한 URL의 마지막 경로 조각에서 `.git`을 뗀 이름. 규칙에 맞지 않으면 repo_name 오류다. */
export function deriveRepoName(url: string): string {
  const last = (matchCloneUrl(url)?.path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
  return parseRepoName(last.replace(/\.git$/, ""));
}

export function parseCloneId(value: unknown): string {
  if (typeof value !== "string" || !CLONE_ID.test(value)) {
    throw new NodeGitServiceError("invalid_request", "clone_id is not valid");
  }
  return value;
}
