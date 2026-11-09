// 시험 픽스처: 가짜 오케스트레이터(HTTP)와 가짜 런타임/앱 묶음을 만든다.
// 실제 오케스트레이터·실제 로그인·실제 런타임 다운로드는 쓰지 않는다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAYLOAD_REQUIRED_FILES,
  PORTABLE_BIND_SCRIPT_FILE,
  PORTABLE_RELEASE_METADATA_FILE,
} from "../lib/release.mjs";

export const PORTABLE_SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
export const TOKEN = "test-node-token-7f3a";

export async function makeTempRoot(name) {
  // macOS의 os.tmpdir()은 /var/folders/.../T/처럼 길어 러너 소켓 경로 한계(103바이트)를 넘는다.
  // 실행기의 검사와 한계값은 그대로 두고, 시험 임시 루트만 darwin에서 짧은 /tmp를 쓴다.
  const base = process.platform === "darwin" ? "/tmp" : tmpdir();
  return mkdtemp(join(base, `portable-${name}-`));
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function run(command, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export async function git(cwd, args, options = {}) {
  const result = await run("git", ["-C", cwd, ...args], options);
  if (options.allowFail !== true && result.code !== 0) {
    throw new Error(`git ${args.join(" ")} 실패: ${result.stderr}`);
  }
  return result;
}

/** 시험용 소스 체크아웃: portable-node 사본 + 로컬 bare origin. */
export async function makeSourceRepo(root) {
  const origin = join(root, "origin.git");
  const repo = join(root, "src");
  await git(root, ["init", "--bare", "--quiet", origin]);
  await git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"], { allowFail: true });
  await git(origin, ["config", "uploadpack.allowFilter", "true"], { allowFail: true });
  await git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"], { allowFail: true });
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "--quiet", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "portable test"]);
  await cp(PORTABLE_SOURCE, join(repo, "portable-node"), {
    recursive: true,
    filter: (source) => !source.includes(`${join(PORTABLE_SOURCE, ".state")}`),
  });
  await writeFile(join(repo, ".gitignore"), "portable-node/.state/\n");
  await writeFile(join(repo, "README.md"), "source checkout\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--quiet", "-m", "A"]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "--quiet", "origin", "main"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    repo,
    portableDir: join(repo, "portable-node"),
    origin,
    firstCommit: head,
    commitFile: async (name, content, message) => {
      await writeFile(join(repo, name), content);
      await git(repo, ["add", name]);
      await git(repo, ["commit", "--quiet", "-m", message]);
      await git(repo, ["push", "--quiet", "origin", "main"]);
      return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    },
  };
}

/**
 * 가짜 오케스트레이터. 참여/릴리스 응답만 돌려준다.
 * state.current, state.bundles, state.pairing 으로 시나리오를 바꾼다.
 */
export async function startFakeOrchestrator({ root, token = TOKEN }) {
  const state = {
    token,
    current: null,
    bundles: new Map(),
    fixtures: new Map(),
    requestPaths: [],
    pairingCount: 0,
    pollCount: 0,
    pairingExpiresAt: new Date(Date.now() + 600000).toISOString(),
    pollPendingOnce: true,
    revoked: false,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requestPaths.push(url.pathname);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const sendJson = (status, value) => {
      const text = JSON.stringify(value);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    };
    const bearer = request.headers.authorization === `Bearer ${state.token}`;

    if (url.pathname === "/api/node-pair/start" && request.method === "POST") {
      state.pairingCount += 1;
      const parsed = JSON.parse(body.toString("utf8") || "{}");
      state.lastPairStart = parsed;
      sendJson(200, {
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        expires_at: state.pairingExpiresAt,
        interval_secs: 1,
      });
      return;
    }
    if (url.pathname === "/api/node-pair/poll" && request.method === "POST") {
      state.pollCount += 1;
      if (new Date(state.pairingExpiresAt).getTime() < Date.now()) {
        sendJson(404, { error: "expired" });
        return;
      }
      if (state.pollPendingOnce && state.pollCount === 1) {
        sendJson(200, { status: "pending" });
        return;
      }
      const parsed = JSON.parse(body.toString("utf8") || "{}");
      if (parsed.device_code !== "device-1") {
        sendJson(404, { error: "unknown" });
        return;
      }
      sendJson(200, { status: "approved", node_id: state.lastPairStart.node_id, company_pc: state.lastPairStart.company_pc, token: state.token });
      return;
    }
    if (url.pathname === "/api/node/releases/current" && request.method === "GET") {
      if (state.revoked) {
        sendJson(401, { error: "revoked" });
        return;
      }
      if (!bearer) {
        sendJson(401, { error: "unauthorized" });
        return;
      }
      if (!state.current) {
        sendJson(503, { error: "not ready" });
        return;
      }
      sendJson(200, state.current);
      return;
    }
    if (url.pathname.startsWith("/fixtures/") && request.method === "GET") {
      const bytes = state.fixtures.get(url.pathname.slice("/fixtures/".length));
      if (!bytes) {
        sendJson(404, { error: "missing" });
        return;
      }
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
      return;
    }
    if (url.pathname.startsWith("/api/node/releases/downloads/") && request.method === "GET") {
      if (!bearer) {
        sendJson(401, { error: "unauthorized" });
        return;
      }
      const key = url.pathname.split("/").pop();
      const bundle = state.bundles.get(key);
      if (!bundle) {
        sendJson(404, { error: "missing" });
        return;
      }
      response.writeHead(200, { "content-type": "application/gzip", "content-length": bundle.length });
      response.end(bundle);
      return;
    }
    sendJson(404, { error: "unknown" });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      }),
  };
}

async function makeTarGz(directory, target) {
  const result = await run("tar", ["-czf", target, "-C", directory, "."]);
  if (result.code !== 0) throw new Error(`tar 실패: ${result.stderr}`);
}

/** 가짜 런타임 네 종을 만들고, 그 URL을 가리키는 시험용 lock을 쓴다. */
export async function makeRuntimeLock(root, baseUrl) {
  const platform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const runtimes = {
    node: { version: process.version.slice(1), executable: "bin/node" },
    claude: { version: "test-1.0.0", executable: "claude" },
    codex: { version: "test-1.0.0", executable: "codex" },
    python: { version: "test-1.0.0", executable: "bin/python3" },
  };
  const platforms = {};
  const archives = {};
  for (const [kind, runtime] of Object.entries(runtimes)) {
    const stage = join(root, `runtime-stage-${kind}`, `fake-${kind}`);
    await mkdir(dirname(join(stage, runtime.executable)), { recursive: true });
    await writeFile(join(stage, runtime.executable), `#!/bin/sh\necho ${kind}\n`, { mode: 0o755 });
    await chmod(join(stage, runtime.executable), 0o755);
    const archive = join(root, `${kind}.tar.gz`);
    await makeTarGz(dirname(stage), archive);
    const bytes = await readFile(archive);
    archives[kind] = bytes;
    platforms[kind] = {
      url: `${baseUrl}/fixtures/${kind}.tar.gz`,
      sha256: sha256(bytes),
      archive: "tar.gz",
      executable: runtime.executable,
    };
  }
  const lock = { schema_version: 1, runtimes: {} };
  for (const [kind, runtime] of Object.entries(runtimes)) {
    lock.runtimes[kind] = {
      version: runtime.version,
      source: "test",
      platforms: { [platform]: platforms[kind] },
    };
  }
  const path = join(root, "runtime-lock.json");
  await writeFile(path, JSON.stringify(lock, null, 2));
  return { path, lock, archives };
}

const childMainSource = ({ crashOnStart = false } = {}) => `import fs from "node:fs";
import path from "node:path";
if (${crashOnStart ? "true" : "false"}) process.exit(1);
const home = process.env.HOME;
fs.writeFileSync(path.join(home, "child-env.json"), JSON.stringify(process.env, null, 2));
fs.writeFileSync(path.join(home, "child-ran.txt"), String(Date.now()));
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid || process.ppid === 1) process.exit(0);
}, 500);
`;

/** bind 횟수를 세어 bindFailAfter번째 호출에서 실패하게 만든다. 판마다 따로 센다. */
const bindMainSource = (bindFailAfter = 0) => `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const releaseDir = value("--release-dir");
const failAfter = ${Number(bindFailAfter)};
if (failAfter > 0) {
  const counterPath = join(releaseDir, "bind-counter.txt");
  let count = 0;
  try { count = Number(readFileSync(counterPath, "utf8")); } catch {}
  count += 1;
  writeFileSync(counterPath, String(count));
  if (count >= failAfter) {
    process.stderr.write("bind refused by test fixture\\n");
    process.exit(1);
  }
}
writeFileSync(join(releaseDir, "release-manifest.json"), JSON.stringify({ schema_version: 1 }));
`;

/**
 * P3 형식의 앱 묶음을 만든다: payload 루트의 main.js·runner/, sha256-<hex> 설명.
 * tamper가 true면 설명과 다른 파일 내용을 넣는다.
 */
export async function makeBundle(
  root,
  { sourceCommit, tamper = false, extraFiles = {}, unsafeLink = null, bindFailAfter = 0, crashOnStart = false },
) {
  const suffix = `${tamper ? "bad" : "ok"}${unsafeLink ? "-link" : ""}${bindFailAfter ? `-bind${bindFailAfter}` : ""}${crashOnStart ? "-crash" : ""}`;
  const payload = join(root, `payload-${sourceCommit.slice(0, 8)}-${suffix}`);
  await rm(payload, { recursive: true, force: true });

  const contents = new Map();
  contents.set("main.js", childMainSource({ crashOnStart }));
  contents.set(PORTABLE_BIND_SCRIPT_FILE, bindMainSource(bindFailAfter));
  contents.set("package.json", '{"name":"soulstream-node-portable","private":true,"type":"module"}\n');
  for (const path of PAYLOAD_REQUIRED_FILES) {
    if (!contents.has(path)) contents.set(path, `// fixture: ${path}\n`);
  }
  for (const [path, content] of Object.entries(extraFiles)) contents.set(path, content);
  for (const [path, content] of contents) {
    await mkdir(dirname(join(payload, path)), { recursive: true });
    await writeFile(join(payload, path), content);
  }

  const files = [];
  for (const path of [...contents.keys()].sort()) {
    const bytes = await readFile(join(payload, path));
    files.push({ path, sha256: `sha256-${sha256(bytes)}`, size: bytes.length });
  }
  const manifest = {
    schema_version: 1,
    source_commit: sourceCommit,
    schema_generation: "schema-gen-fixture",
    wire_generation: "wire-gen-fixture",
    files,
  };
  await writeFile(join(payload, PORTABLE_RELEASE_METADATA_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  if (tamper) await writeFile(join(payload, "main.js"), `${childMainSource({ crashOnStart })}\n// tampered\n`);
  if (unsafeLink) await symlink(unsafeLink.target, join(payload, unsafeLink.path));
  const archive = join(root, `bundle-${sourceCommit.slice(0, 8)}-${suffix}.tar.gz`);
  await makeTarGz(payload, archive);
  const bytes = await readFile(archive);
  return { bytes, sha256: sha256(bytes), size: bytes.length, dir: payload, files };
}

export function releaseRecord({ sourceCommit, bundle, key }) {
  return {
    contract_version: 1,
    source_commit: sourceCommit,
    sha256: `sha256-${bundle.sha256}`,
    size: bundle.size,
    download_path: `/api/node/releases/downloads/${key}`,
  };
}

export async function writeDefaults(root, upstream, overrides = {}) {
  const defaults = {
    schema_version: 1,
    upstream,
    node_ws_url: `${upstream.replace(/^http/, "ws")}/ws/node`,
    check_interval_secs: 1,
    json_timeout_ms: 5000,
    stream_timeout_ms: 60000,
    pairing_poll_interval_secs: 1,
    restart_delay_ms: 300,
    ready_window_ms: 500,
    shutdown_grace_ms: 3000,
    ...overrides,
  };
  const path = join(root, "defaults.json");
  await writeFile(path, JSON.stringify(defaults, null, 2));
  return path;
}

export function launcherEnv({ stateDir, defaultsPath, lockPath, answers, extra = {} }) {
  return {
    ...process.env,
    PORTABLE_NODE_STATE_DIR: stateDir,
    PORTABLE_NODE_DEFAULTS: defaultsPath,
    PORTABLE_NODE_RUNTIME_LOCK: lockPath,
    PORTABLE_NODE_ANSWERS: JSON.stringify(answers ?? { node_id: "portable-test-node" }),
    PORTABLE_NODE_TEST_SKIP_CODEX_LOGIN: "1",
    ...extra,
  };
}

/** launcher가 child를 감독하기 시작했는지(로그)와 child가 실제로 떴는지(표식)를 함께 기다린다. */
export async function waitForStarted(handle, stateDir, { timeoutMs = 180000 } = {}) {
  await waitFor(() => handle.output.includes("soul-server를 시작했습니다"), { timeoutMs });
  await waitFor(() => existsSync(join(stateDir, "home", "child-ran.txt")), { timeoutMs: 60000 });
}

export async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("조건을 기다리다 시간이 지났습니다.");
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

/**
 * start.sh와 같은 재진입 루프로 launcher를 돌린다.
 * exit 75면 새로 띄우고, 그 밖의 코드면 끝난다.
 */
export function startLauncher({ portableDir, env, onLine }) {
  const child = spawn(process.execPath, [join(portableDir, "launcher.mjs")], {
    cwd: dirname(portableDir),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk) => {
    const text = chunk.toString("utf8");
    output += text;
    if (onLine) for (const line of text.split("\n")) if (line.trim()) onLine(line);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    get output() {
      return output;
    },
    exit,
    stop: () => child.kill("SIGTERM"),
  };
}

/** start.sh처럼 exit 75에서 다시 띄우는 시험용 껍데기. */
export function startShim(options) {
  let currentHandle = null;
  let accumulated = "";
  let stopping = false;
  const exit = (async () => {
    for (;;) {
      if (stopping) return { code: 0, signal: null, output: accumulated };
      currentHandle = startLauncher(options);
      const result = await currentHandle.exit;
      accumulated += currentHandle.output;
      if (result.code === 75) continue;
      return { ...result, output: accumulated };
    }
  })();
  return {
    get output() {
      return accumulated + (currentHandle?.output ?? "");
    },
    get child() {
      return currentHandle?.child ?? null;
    },
    exit,
    stop() {
      stopping = true;
      currentHandle?.child.kill("SIGTERM");
    },
  };
}

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const CONFIG_GENERATION_PATTERN = /^local-[0-9a-f]{12}$/;

/** 실행기가 만든 구성 세대 폴더 목록(내용 기반 이름이라 판과 무관하게 하나여야 한다). */
export async function configGenerations(stateDir) {
  const entries = await readdir(join(stateDir, "config"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && CONFIG_GENERATION_PATTERN.test(entry.name))
    .map((entry) => join(stateDir, "config", entry.name));
}

/** 한 시험에 필요한 가짜 오케스트레이터·소스 체크아웃·런타임을 한 번에 만든다. */
export async function makeScenario(name, { checkIntervalSecs = 3600 } = {}) {
  const root = await makeTempRoot(name);
  const source = await makeSourceRepo(root);
  const stateDir = join(root, "state");
  const orch = await startFakeOrchestrator({ root });
  const lock = await makeRuntimeLock(root, orch.url);
  for (const [kind, bytes] of Object.entries(lock.archives)) {
    orch.state.fixtures.set(`${kind}.tar.gz`, bytes);
  }
  const defaultsPath = await writeDefaults(root, orch.url, { check_interval_secs: checkIntervalSecs });
  let publishCount = 0;
  const publish = async (sourceCommit, options = {}) => {
    publishCount += 1;
    const key = `bundle-${publishCount}`;
    const bundle = await makeBundle(root, { sourceCommit, ...options });
    orch.state.bundles.set(key, bundle.bytes);
    orch.state.current = releaseRecord({ sourceCommit, bundle, key });
    return { bundle, release: orch.state.current };
  };
  const env = (extra = {}) => launcherEnv({ stateDir, defaultsPath, lockPath: lock.path, extra });
  const close = async () => {
    await orch.close();
    await rm(root, { recursive: true, force: true });
  };
  return { root, source, stateDir, orch, lock, defaultsPath, publish, env, close };
}

export { relative };
