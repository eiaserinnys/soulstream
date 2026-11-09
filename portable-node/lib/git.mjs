import { spawn } from "node:child_process";
import { join } from "node:path";

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

async function git(args, { cwd, stateRoot, input, timeoutMs } = {}) {
  const result = await run("git", args, { cwd, env: gitEnv(stateRoot), input, timeoutMs });
  return result;
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

