import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class GitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

const GIT_MIN_VERSION = [2, 25, 0];

export function run(command, args, { cwd, env, input, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} 시간 초과 (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const SYSTEM_ENV_KEYS = [
  "PATH",
  "Path",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/** 부모 환경을 통째로 물려주지 않고 OS 실행에 필요한 최소 키만 가져온다. */
function baseEnv() {
  const env = {};
  for (const key of SYSTEM_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** GIT_CONFIG_GLOBAL 등은 이 프로세스가 띄우는 자식에게만 주고, 부모의 비밀값은 넘기지 않는다. */
export function gitEnv(stateRoot, extra = {}) {
  const home = join(stateRoot, "home");
  const tmp = join(stateRoot, "tmp");
  return {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(stateRoot, "git", "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    ...extra,
  };
}

function parseVersion(text) {
  const match = /git version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export async function assertGit() {
  let result;
  try {
    result = await run("git", ["--version"], { timeoutMs: 20000 });
  } catch {
    throw new GitError(
      "git을 찾지 못했습니다. Git을 설치한 뒤 다시 실행하십시오. (전체 복제로 대신하지 않습니다.)",
      "GIT_MISSING",
    );
  }
  const version = parseVersion(result.stdout);
  if (result.code !== 0 || !version) {
    throw new GitError("git 버전을 확인하지 못했습니다. Git을 다시 설치하십시오.", "GIT_MISSING");
  }
  for (let i = 0; i < GIT_MIN_VERSION.length; i += 1) {
    if (version[i] > GIT_MIN_VERSION[i]) return version;
    if (version[i] < GIT_MIN_VERSION[i]) {
      throw new GitError(
        `git ${GIT_MIN_VERSION.join(".")} 이상이 필요합니다. 현재 ${version.join(".")}입니다.`,
        "GIT_TOO_OLD",
      );
    }
  }
  return version;
}

export async function writeCredentialHelper(stateRoot, { nodePath }) {
  const gitDir = join(stateRoot, "git");
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  const helperPath = join(gitDir, "credential-helper.mjs");
  await writeFile(helperPath, CREDENTIAL_HELPER_SOURCE, { mode: 0o600 });

  const configPath = join(gitDir, "gitconfig");
  await writeFile(configPath, "", { mode: 0o600 });

  const toShellPath = (value) => value.replace(/\\/g, "/");
  const helperCommand = `!"${toShellPath(nodePath)}" "${toShellPath(helperPath)}" "${toShellPath(join(stateRoot, "node.json"))}"`;
  const env = gitEnv(stateRoot);
  for (const [key, value] of [
    ["credential.useHttpPath", "true"],
    ["credential.helper", helperCommand],
    ["core.longpaths", "true"],
    ["http.postBuffer", "524288000"],
  ]) {
    const result = await run("git", ["config", "--file", configPath, key, value], { env });
    if (result.code !== 0) {
      throw new GitError(`git 설정을 쓰지 못했습니다: ${key}`, "GIT_CONFIG_FAILED");
    }
  }
  return { configPath, helperPath };
}

export function repoUrl(upstream, proxyPath) {
  return new URL(proxyPath, upstream).toString();
}

async function git(args, { cwd, stateRoot, input, timeoutMs } = {}) {
  const result = await run("git", args, { cwd, env: gitEnv(stateRoot), input, timeoutMs });
  return result;
}

async function gitOrThrow(args, options, code) {
  const result = await git(args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new GitError(detail || `git ${args[0]} 실패`, code);
  }
  return result;
}

/**
 * 서버가 부분 복제를 광고하는지 전송 전에 확인한다.
 * protocol v2 협상 줄을 GIT_TRACE_PACKET으로 받아, 서버 능력에 filter가 있는지만 본다.
 */
export async function assertPartialCloneSupported({ stateRoot, url }) {
  const result = await run("git", ["-c", "protocol.version=2", "ls-remote", url, "HEAD"], {
    env: gitEnv(stateRoot, { GIT_TRACE_PACKET: "1" }),
    timeoutMs: 120000,
  });
  if (result.code !== 0) {
    throw new GitError(
      `리포에 연결하지 못했습니다: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`,
      "GIT_CONNECT_FAILED",
    );
  }
  for (const line of `${result.stderr}\n${result.stdout}`.split(/\r?\n/)) {
    const match = /packet:.*\bgit<\s+(.+)$/.exec(line);
    if (match && /(^|\s)filter(\s|$)/.test(match[1])) return;
  }
  throw new GitError(
    "서버가 부분 복제를 지원하지 않습니다. 전체 복제로 대신하지 않고 멈춥니다.",
    "PARTIAL_CLONE_UNSUPPORTED",
  );
}

export async function cloneWorkspace({ stateRoot, target, upstream, proxyPath, sparsePatterns }) {
  const url = repoUrl(upstream, proxyPath);
  await assertPartialCloneSupported({ stateRoot, url });
  await gitOrThrow(
    ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", url, target],
    { stateRoot, timeoutMs: 3600000 },
    "CLONE_FAILED",
  );
  const filter = await git(["-C", target, "config", "--get", "remote.origin.partialclonefilter"], { stateRoot });
  if (filter.stdout.trim() !== "blob:none") {
    throw new GitError(
      "서버가 부분 복제를 지원하지 않습니다. 전체 복제로 대신하지 않고 멈춥니다.",
      "PARTIAL_CLONE_UNSUPPORTED",
    );
  }
  await gitOrThrow(
    ["-C", target, "sparse-checkout", "set", "--no-cone", ...sparsePatterns],
    { stateRoot },
    "SPARSE_FAILED",
  );
  await gitOrThrow(["-C", target, "checkout"], { stateRoot, timeoutMs: 3600000 }, "CHECKOUT_FAILED");
}

export async function cloneFull({ stateRoot, target, upstream, proxyPath }) {
  const url = repoUrl(upstream, proxyPath);
  await gitOrThrow(
    ["clone", "--depth", "1", url, target],
    { stateRoot, timeoutMs: 3600000 },
    "CLONE_FAILED",
  );
}

/**
 * 시작할 때마다 origin을 받아 ff-only로만 전진한다.
 * shallow 리포에 --depth 1을 다시 걸면 기존 HEAD와 이력이 끊기므로 깊이를 주지 않는다.
 * 로컬 변경을 건드리지 않으며, 실패는 경고로 남기고 계속한다.
 */
export async function syncRepo({ stateRoot, dir }) {
  const fetchResult = await git(["-C", dir, "fetch", "origin"], {
    stateRoot,
    timeoutMs: 600000,
  });
  if (fetchResult.code !== 0) {
    return { ok: false, message: `가져오기 실패: ${fetchResult.stderr.trim()}` };
  }
  const mergeHead = await git(["-C", dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"], { stateRoot });
  if (mergeHead.code === 0) {
    await git(["-C", dir, "merge", "--abort"], { stateRoot });
  }
  const mergeResult = await git(["-C", dir, "merge", "--ff-only", "FETCH_HEAD"], { stateRoot });
  if (mergeResult.code !== 0) {
    return {
      ok: false,
      message: `로컬 변경을 보존한 채로는 앞으로 보내지 못했습니다: ${mergeResult.stderr.trim()}`,
    };
  }
  return { ok: true };
}

export async function currentHead(dir, { stateRoot }) {
  const result = await git(["-C", dir, "rev-parse", "HEAD"], { stateRoot });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * 체크아웃을 릴리스의 source_commit으로 맞춘다. 변경이 있으면 손대지 않는다.
 * origin/main을 당기지 않고, git clean도 쓰지 않는다.
 */
export async function alignCheckout({ stateRoot, root, sourceCommit }) {
  const status = await git(["-C", root, "status", "--porcelain"], { stateRoot });
  if (status.code !== 0) {
    return { aligned: false, reason: "status_failed", message: status.stderr.trim() };
  }
  if (status.stdout.trim() !== "") {
    return {
      aligned: false,
      reason: "dirty",
      message: "작업 트리에 변경이 있어 판 맞춤을 건너뜁니다. 변경을 보존합니다.",
    };
  }
  const before = await currentHead(root, { stateRoot });
  if (before === sourceCommit) return { aligned: true, changed: false, head: before };

  const fetch = await git(["-C", root, "fetch", "--depth", "1", "origin", sourceCommit], {
    stateRoot,
    timeoutMs: 600000,
  });
  if (fetch.code !== 0) {
    return { aligned: false, reason: "fetch_failed", message: fetch.stderr.trim() };
  }
  const fetched = await git(["-C", root, "rev-parse", "FETCH_HEAD"], { stateRoot });
  if (fetched.stdout.trim() !== sourceCommit) {
    return {
      aligned: false,
      reason: "sha_mismatch",
      message: `가져온 커밋이 릴리스와 다릅니다 (${fetched.stdout.trim()}).`,
    };
  }
  const checkout = await git(["-C", root, "checkout", "--detach", sourceCommit], { stateRoot });
  if (checkout.code !== 0) {
    return { aligned: false, reason: "checkout_failed", message: checkout.stderr.trim() };
  }
  return { aligned: true, changed: true, head: sourceCommit, previous: before };
}

const CREDENTIAL_HELPER_SOURCE = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

// git은 설정된 명령 뒤에 동작 이름을 붙여 실행한다: node helper.mjs <node.json> <동작>
const statePath = process.argv[2];
const operation = process.argv[3];
if (operation === "store" || operation === "erase") process.exit(0);
if (operation !== "get") process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const fields = {};
  for (const line of input.split("\\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    process.exit(0);
  }
  if (!state || !state.token || !state.upstream) process.exit(0);
  let upstream;
  try {
    upstream = new URL(state.upstream);
  } catch {
    process.exit(0);
  }
  const protocol = String(fields.protocol ?? "").toLowerCase();
  const expectedProtocol = upstream.protocol.replace(/:$/, "").toLowerCase();
  const host = String(fields.host ?? "").toLowerCase();
  const path = String(fields.path ?? "").replace(/^\\/+/, "").replace(/\\/+$/, "");
  const allowed = ["api/node/git/seosoyoung_workspace", "api/node/git/seosoyoung-common"];
  if (protocol !== expectedProtocol) process.exit(0);
  if (host !== upstream.host.toLowerCase() || !allowed.includes(path)) process.exit(0);
  process.stdout.write("username=soulstream-node\\npassword=" + state.token + "\\n");
});
`;
