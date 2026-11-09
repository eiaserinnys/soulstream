import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { filterEnv, formatEnvFile } from "./config.mjs";
import { run } from "./git.mjs";
import { runBind } from "./release.mjs";

const log = (message) => process.stdout.write(`[portable-node] ${message}\n`);

export function probePort(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

function allocatePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * 이전에 쓴 두 loopback 포트를 다시 쓰되, 이미 점유됐으면 새로 잡는다.
 * 포트는 child env와 release manifest의 신원 값이므로 node.json에 남긴다.
 */
export async function ensurePorts(stateRoot, node, writeNodeFile) {
  const saved = node.ports ?? {};
  const host = saved.host && (await probePort(saved.host)) ? saved.host : await allocatePort();
  let mcp = saved.mcp && saved.mcp !== host && (await probePort(saved.mcp)) ? saved.mcp : null;
  if (!mcp) {
    do {
      mcp = await allocatePort();
    } while (mcp === host);
  }
  if (saved.host !== host || saved.mcp !== mcp) {
    node.ports = { host, mcp };
    await writeNodeFile(node);
  }
  return node.ports;
}

export async function ensurePythonWrapper(stateRoot, pythonExecutable) {
  const target = join(stateRoot, "bin", process.platform === "win32" ? "python3.cmd" : "python3");
  const body =
    process.platform === "win32"
      ? `@echo off\r\n"${pythonExecutable}" %*\r\n`
      : `#!/bin/sh\nexec "${pythonExecutable}" "$@"\n`;
  await writeFile(target, body, { mode: 0o755 });
  if (process.platform !== "win32") await chmod(target, 0o755);
  return target;
}

export async function ensureCodexLogin({ stateRoot, codexExecutable, env }) {
  const codexHome = join(stateRoot, "codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  let existing = null;
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    existing = null;
  }
  if (existing === null) {
    await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  } else if (!/cli_auth_credentials_store/.test(existing)) {
    const suffix = existing.endsWith("\n") ? "" : "\n";
    await writeFile(configPath, `${existing}${suffix}cli_auth_credentials_store = "file"\n`, { mode: 0o600 });
  }
  if (process.env.PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN === "1") {
    log("시험 모드: Codex 로그인 확인을 건너뜁니다.");
    return;
  }
  const status = await run(codexExecutable, ["login", "status"], { env, timeoutMs: 60000 });
  if (status.code === 0) return;
  log("Codex 로그인이 필요합니다. 아래 안내에 따라 승인하십시오.");
  await new Promise((done, fail) => {
    const child = spawn(codexExecutable, ["login", "--device-auth"], { env, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? done() : fail(new Error(`codex login이 ${code}로 끝났습니다.`))));
  });
  const recheck = await run(codexExecutable, ["login", "status"], { env, timeoutMs: 60000 });
  if (recheck.code !== 0) throw new Error("Codex 로그인이 완료되지 않았습니다.");
}

/**
 * 부모 환경을 통째로 물려주지 않는다. OS 실행에 필요한 최소 키만 가져오고,
 * 나머지는 launcher가 소유한 명시 값과 bootstrap이 허용 목록으로 준 값만 쓴다.
 */
export function buildChildEnv({
  stateRoot,
  defaults,
  node,
  configDir,
  releaseDir,
  runtimes,
  ports,
  extraEnv,
}) {
  const inherited = {};
  for (const key of ["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]) {
    if (process.env[key] !== undefined) inherited[key] = process.env[key];
  }
  const { env: fromBootstrap, rejected } = filterEnv(extraEnv ?? {});
  if (rejected.length > 0) log(`허용하지 않는 환경 키를 버렸습니다: ${rejected.join(", ")}`);
  const home = join(stateRoot, "home");
  const pathParts = [
    join(stateRoot, "bin"),
    dirname(runtimes.node.executable),
    dirname(runtimes.python.executable),
    dirname(runtimes.claude.executable),
    dirname(runtimes.codex.executable),
    process.env.PATH ?? process.env.Path ?? "",
  ].filter((part) => part.length > 0);
  return {
    ...inherited,
    ...fromBootstrap,
    SOULSTREAM_NODE_ID: node.node_id,
    SOULSTREAM_UPSTREAM_URL: defaults.node_ws_url,
    AUTH_BEARER_TOKEN: node.token,
    ENVIRONMENT: "production",
    HOST: "127.0.0.1",
    PORT: String(ports.host),
    MCP_INTERNAL_PORT: String(ports.mcp),
    LOG_LEVEL: "info",
    MCP_ENABLED: "true",
    MCP_PATH: "/mcp",
    MCP_REQUIRE_AUTH: "true",
    MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
    AGENTS_CONFIG_PATH: join(configDir, "agents.yaml"),
    MODEL_CATALOG_PATH: join(configDir, "model-catalog.yaml"),
    AGENT_PROFILE_CACHE_PATH: join(stateRoot, "cache", "agent-profile-cache.json"),
    EVENT_OUTBOX_DIR: join(stateRoot, "outbox"),
    INCOMING_FILE_DIR: join(stateRoot, "incoming"),
    SOUL_RUNNER_PROCESS_ENABLED: "true",
    SOUL_RUNNER_STATE_DIR: join(stateRoot, "r"),
    SOUL_RUNNER_ARTIFACT_DIR: join(releaseDir, "dist", "runner"),
    SOUL_RUNNER_RELEASES_DIR: join(stateRoot, "runner", "releases"),
    CLAUDE_CODE_EXECPATH: runtimes.claude.executable,
    CODEX_CLI_PATH: runtimes.codex.executable,
    CODEX_ADAPTER_MODE: "app-server",
    CLAUDE_ACCOUNT_POOL_ENABLED: "true",
    CLAUDE_ACCOUNTS_DIR: join(stateRoot, "claude-accounts"),
    CODEX_HOME: join(stateRoot, "codex"),
    AGENT_COMMON_FILES_DIR: join(stateRoot, "common"),
    WORKTREE_MCP_ENABLED: "true",
    WORKTREE_PROJECTS_ROOT: join(stateRoot, "workspace", ".projects"),
    ATOM_ENABLED: "true",
    SESSION_ISOLATION_MODE: "off",
    DISABLE_AUTOUPDATER: "1",
    PATH: pathParts.join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(stateRoot, "tmp"),
    TEMP: join(stateRoot, "tmp"),
    TMP: join(stateRoot, "tmp"),
    GIT_CONFIG_GLOBAL: join(stateRoot, "git", "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** env 파일을 릴리스 폴더에 쓰고 같은 파일로 release manifest를 바인딩한다. */
export async function prepareRelease({
  stateRoot,
  defaults,
  node,
  configDir,
  releaseDir,
  runtimes,
  ports,
  extraEnv,
}) {
  const env = buildChildEnv({
    stateRoot,
    defaults,
    node,
    configDir,
    releaseDir,
    runtimes,
    ports,
    extraEnv,
  });
  const envFile = join(releaseDir, ".env.soul-server-ts");
  await writeFile(envFile, formatEnvFile(env), { mode: 0o600 });
  await runBind({ releaseDir, nodePath: process.execPath, envFile, env });
  return { env, envFile };
}
