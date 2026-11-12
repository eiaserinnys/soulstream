import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..");
/** Repo canonical catalogue the bound portable release reads at startup. */
const catalogPath = join(repositoryRoot, "packages", "model-catalog", "data", "model-catalog.yaml");
const hostDist = join(packageRoot, "dist");
const tsxCli = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const execFileAsync = promisify(execFile);
/** Ambient env a bare `node main.js` gets: no credentials, no release document, no npm. */
const CLEAN_AMBIENT = { PATH: process.env.PATH ?? "", HOME: tmpdir() };
/** Test-only bearer the env document declares so the MCP route requires auth. */
const MCP_TOKEN = "portable-release-e2e-token";

let temporaryRoot;
let releaseDirectory;
let tamperedDirectory;
let appRoot;
let envFile;
let packSummary;
let sourceCommit;
let runnerArtifacts;

before(async () => {
  // `pack:portable` labels the payload with git HEAD and refuses a dirty tree,
  // so this test only runs from a clean commit: it must never pack local edits.
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    "",
    "verify:portable packs the current commit: commit or stash the working tree first",
  );
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  // The runner artifact list is read from the materializer, not retyped here.
  runnerArtifacts = JSON.parse(execFileSync(process.execPath, [
    tsxCli,
    "-e",
    "import('./src/runner/runner_release_materializer.js')"
      + ".then((module) => process.stdout.write(JSON.stringify(module.RUNNER_RELEASE_ARTIFACTS)))",
  ], { cwd: packageRoot, encoding: "utf8" }));
  temporaryRoot = await mkdtemp(join(tmpdir(), "soulstream-portable-release-"));
  appRoot = join(temporaryRoot, "app");
  await mkdir(join(appRoot, "workspace"), { recursive: true });
  await mkdir(join(appRoot, "runner-state"), { recursive: true });
  await writeFile(join(appRoot, "agents.yaml"), [
    "agents:",
    "  - id: portable-release",
    "    name: Portable Release",
    "    backend: codex",
    `    workspace_dir: ${join(appRoot, "workspace")}`,
    "",
  ].join("\n"), "utf8");

  const outRoot = join(temporaryRoot, "out");
  // No --source-commit and no bypass: the pack builds the artifact sets itself
  // and labels the payload with the HEAD it verified, so there is nothing for
  // this test to supply or override.
  const pack = await execFileAsync(process.execPath, [
    tsxCli,
    join(packageRoot, "scripts", "pack_portable_release.ts"),
    "--out", outRoot,
  ], { cwd: packageRoot, maxBuffer: 64 * 1024 * 1024 });
  packSummary = JSON.parse(pack.stdout.trim().split("\n").at(-1));
  assert.equal(packSummary.source_commit, sourceCommit);

  releaseDirectory = join(temporaryRoot, "release");
  await mkdir(releaseDirectory, { recursive: true });
  await execFileAsync("tar", ["-xzf", packSummary.tarball, "-C", releaseDirectory]);
  envFile = join(releaseDirectory, ".env.soul-server-ts");
  const port = await reservePort();
  const mcpInternalPort = await reservePort();
  await writeFile(envFile, [
    "SOULSTREAM_NODE_ID=portable-release-e2e",
    "SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:9/ws/node",
    `EVENT_OUTBOX_DIR=${join(appRoot, "event-outbox")}`,
    `PORT=${port}`,
    "HOST=127.0.0.1",
    "LOG_LEVEL=error",
    // The node-local MCP listener is what actually runs the SDK transport;
    // require a bearer so the test proves the auth path as well as initialize.
    "MCP_ENABLED=true",
    "MCP_REQUIRE_AUTH=true",
    `MCP_INTERNAL_PORT=${mcpInternalPort}`,
    `AUTH_BEARER_TOKEN=${MCP_TOKEN}`,
    `AGENTS_CONFIG_PATH=${join(appRoot, "agents.yaml")}`,
    `AGENT_PROFILE_CACHE_PATH=${join(appRoot, "agent-profile-cache.json")}`,
    "SOUL_RUNNER_PROCESS_ENABLED=true",
    `SOUL_RUNNER_STATE_DIR=${join(appRoot, "runner-state")}`,
    // config.ts requires an explicit artifact directory whenever the runner
    // process is enabled; the payload ships that directory next to main.js.
    `SOUL_RUNNER_ARTIFACT_DIR=${join(releaseDirectory, "runner")}`,
    `SOUL_RUNNER_RELEASES_DIR=${join(appRoot, "releases")}`,
    "",
  ].join("\n"), "utf8");
  // Everything the runtime hashes and imports, before bind writes a manifest.
  tamperedDirectory = join(temporaryRoot, "tampered");
  await cp(releaseDirectory, tamperedDirectory, { recursive: true });
});

after(async () => {
  if (!temporaryRoot) return;
  await makeDirectoriesWritable(temporaryRoot);
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("the tarball lists and hashes every delivered file", async () => {
  const tarball = await readFile(packSummary.tarball);
  assert.equal(`sha256-${sha256(tarball)}`, packSummary.sha256);
  assert.equal(tarball.byteLength, packSummary.size);
  const sidecar = await readFile(`${packSummary.tarball}.sha256`, "utf8");
  assert.equal(sidecar, `${sha256(tarball)}  node.tar.gz\n`);
  assert.equal(basename(packSummary.tarball), "node.tar.gz");
  assert.equal(
    dirname(packSummary.tarball).endsWith(sourceCommit),
    true,
    "tarball must live under <out>/<source_commit>/",
  );

  const metadata = JSON.parse(
    await readFile(join(releaseDirectory, "portable-release.json"), "utf8"),
  );
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.source_commit, sourceCommit);
  assert.match(metadata.schema_generation, /^[^:]+:[0-9a-f]{64}:sha256-[0-9a-f]{64}$/);
  assert.match(metadata.wire_generation, /^sha256-[0-9a-f]{64}$/);

  // The node-local documents bind and startup tolerate are not payload files.
  const nodeLocalFiles = new Set(["portable-release.json", ".env.soul-server-ts"]);
  const onDisk = (await walkFiles(releaseDirectory))
    .filter((relativePath) => !nodeLocalFiles.has(relativePath));
  assert.deepEqual(onDisk, metadata.files.map((file) => file.path).sort());
  assert.equal(packSummary.files, metadata.files.length);
  assert.equal(
    await exists(join(releaseDirectory, "node_modules")),
    false,
    "payload must not ship node_modules",
  );
  assert.equal(onDisk.some((relativePath) => relativePath.endsWith(".map")), false);
  assert.equal(
    onDisk.some((relativePath) => /^chunk-[A-Z0-9]+\.js$/.test(relativePath)),
    true,
    "bundled chunk files must be delivered and listed",
  );
  for (const file of metadata.files) {
    const contents = await readFile(join(releaseDirectory, ...file.path.split("/")));
    assert.equal(contents.byteLength, file.size, file.path);
    assert.equal(`sha256-${sha256(contents)}`, file.sha256, file.path);
  }
});

test("the packer derives the same schema and wire generations as the host build", async () => {
  const central = JSON.parse(await readFile(join(hostDist, "release-manifest.json"), "utf8"));
  const metadata = JSON.parse(
    await readFile(join(releaseDirectory, "portable-release.json"), "utf8"),
  );
  assert.equal(metadata.schema_generation, central.schema_generation);
  assert.equal(metadata.wire_generation, central.wire_generation);
});

test("copying the central build manifest into the payload is refused at startup", async () => {
  const manifestPath = join(releaseDirectory, "release-manifest.json");
  await cp(join(hostDist, "release-manifest.json"), manifestPath);
  try {
    const result = await runProcess(process.execPath, [join(releaseDirectory, "main.js")], {
      cwd: releaseDirectory,
      env: CLEAN_AMBIENT,
      timeoutMs: 30_000,
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /release manifest mismatch/);
  } finally {
    await rm(manifestPath, { force: true });
  }
});

test("a tampered payload is refused and no manifest is written", async () => {
  const target = join(tamperedDirectory, "main.js");
  const original = await readFile(target);
  // Same length, one changed byte: only the digest can tell.
  original[0] = original[0] === 0x2f ? 0x5c : 0x2f;
  await writeFile(target, original);

  const result = await runProcess(process.execPath, [
    join(tamperedDirectory, "bind-release.mjs"),
    "--release-dir", tamperedDirectory,
    "--env-file", join(tamperedDirectory, ".env.soul-server-ts"),
  ], { cwd: tamperedDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });

  assert.notEqual(result.code, 0);
  assert.match(result.output, /^bind-release: portable release file hash mismatch: main\.js$/m);
  assert.equal(await exists(join(tamperedDirectory, "release-manifest.json")), false);
});

test("the bound release starts main.js without node_modules and reports starting", async () => {
  const bind = await runProcess(process.execPath, [
    join(releaseDirectory, "bind-release.mjs"),
    "--release-dir", releaseDirectory,
    "--env-file", envFile,
    "--catalog-path", catalogPath,
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.equal(bind.code, 0, bind.output);
  assert.match(bind.output, /^bind-release: bound [0-9a-f]{40} manifest=sha256-[0-9a-f]{64} /m);

  const manifest = JSON.parse(await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"));
  assert.equal(manifest.source_commit, sourceCommit);
  assert.equal(manifest.model_catalog_path, catalogPath);
  assert.equal(manifest.node.version, process.versions.node);

  const port = Number((await readFile(envFile, "utf8"))
    .match(/^PORT=(\d+)$/m)?.[1]);
  assert(Number.isInteger(port) && port > 0, "PORT missing from the env document");
  const child = spawn(process.execPath, [join(releaseDirectory, "main.js")], {
    cwd: releaseDirectory,
    env: CLEAN_AMBIENT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    const response = await waitForHealth(child, port, () => output);
    assert.equal(response.status, 503, output);
    const health = await response.json();
    assert.equal(health.status, "starting");
    assert.equal(health.node_id, "portable-release-e2e");
    assert.equal(health.manifest_id, manifest.manifest_id);
    assert.equal(health.activation_generation, null);
    assert.doesNotMatch(output, /Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/);
  } finally {
    await stopProcess(child);
  }
});

test("the runner release prewarms and the runner entry loads from the payload alone", async () => {
  const prewarm = await runProcess(process.execPath, [
    join(releaseDirectory, "runner", "runner_release_prewarm.js"),
    "--artifacts", join(releaseDirectory, "runner"),
    "--releases", join(temporaryRoot, "prewarm-releases"),
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.equal(prewarm.code, 0, prewarm.output);
  const release = JSON.parse(prewarm.output.trim());
  assert.match(release.release_id, /^sha256-[0-9a-f]{64}$/);
  const entries = (await readdir(release.release_root)).sort();
  assert.deepEqual(entries, [".runner-release.json", ...runnerArtifacts].sort());

  // No --config: the entry fails on its own contract, but only after the whole
  // bundled module graph loaded. A leftover bare import would fail earlier.
  const entry = await runProcess(process.execPath, [
    join(releaseDirectory, "runner", "runner_entry.js"),
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.notEqual(entry.code, 0);
  assert.match(entry.output, /runner entry requires --config/);
  assert.doesNotMatch(entry.output, /Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("the bound release answers a bearer-authenticated MCP initialize", async () => {
  const port = Number((await readFile(envFile, "utf8")).match(/^PORT=(\d+)$/m)?.[1]);
  const mcpPort = Number(
    (await readFile(envFile, "utf8")).match(/^MCP_INTERNAL_PORT=(\d+)$/m)?.[1],
  );
  // Tests run in order, but keep this one runnable on its own.
  if (!await exists(join(releaseDirectory, "release-manifest.json"))) {
    const bind = await runProcess(process.execPath, [
      join(releaseDirectory, "bind-release.mjs"),
      "--release-dir", releaseDirectory,
      "--env-file", envFile,
      "--catalog-path", catalogPath,
    ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
    assert.equal(bind.code, 0, bind.output);
  }
  const child = spawn(process.execPath, [join(releaseDirectory, "main.js")], {
    cwd: releaseDirectory,
    env: CLEAN_AMBIENT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "portable-release-e2e", version: "1.0.0" },
    },
  };
  try {
    await waitForHealth(child, port, () => output);
    const endpoint = `http://127.0.0.1:${mcpPort}/mcp/internal`;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const anonymous = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(initialize),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(anonymous.status, 401, output);
    await anonymous.body?.cancel();

    const authorized = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify(initialize),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(authorized.status, 200, output);
    const payload = await readMcpPayload(authorized);
    assert.equal(payload.jsonrpc, "2.0");
    assert.equal(payload.id, 1);
    assert.equal(typeof payload.result?.protocolVersion, "string");
    assert.equal(payload.result?.serverInfo?.name, "soul-server-ts");
  } finally {
    await stopProcess(child);
  }
});

test("the payload's own engine code spawns the claude CLI from a clean directory", async () => {
  await exerciseRunnerEngineSpawn({ backend: "claude", cliEnvName: "CLAUDE_CODE_EXECPATH" });
});

test("the payload's own engine code spawns the codex app-server from a clean directory", async () => {
  await exerciseRunnerEngineSpawn({ backend: "codex", cliEnvName: "CODEX_CLI_PATH" });
});

async function walkFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walkFiles(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

async function waitForHealth(child, port, readOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `main.js exited before the health check (code=${child.exitCode})\n${readOutput()}`,
      );
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`main.js did not answer /health\n${readOutput()}`);
}

/**
 * Runs the payload's own runner entry from the extracted release directory and
 * acts as the host over its Unix socket. The point is not to finish a turn but
 * to reach the engine spawn: the fake CLI records its argv, which proves the
 * bundled module graph loaded and the adapter reached its child-process call
 * without node_modules or the vendor tree.
 */
async function exerciseRunnerEngineSpawn({ backend, cliEnvName }) {
  const root = join(temporaryRoot, "runner-child", backend);
  const sessionDirectory = join(root, "session");
  const snapshotPath = join(root, "snapshot");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(snapshotPath, { recursive: true });

  const databasePath = join(sessionDirectory, "runner.db");
  const socketPath = join(sessionDirectory, "runner.sock");
  const configPath = join(sessionDirectory, "runner-config.json");
  const fakeCli = join(root, backend === "claude" ? "fake-claude.sh" : "fake-codex.sh");
  const recordPath = join(root, "spawned-argv.txt");
  await writeFile(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recordPath}'\n`, "utf8");
  await chmod(fakeCli, 0o755);

  // The host normally creates the outbox database before spawning the child.
  const initialized = await runProcess(process.execPath, [
    join(releaseDirectory, "runner", "runner_release_prewarm.js"),
    "--database", databasePath,
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.equal(initialized.code, 0, initialized.output);

  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    sessionId: `portable-release-${backend}`,
    backend,
    agent: {
      id: `portable-release-${backend}`,
      name: `Portable Release ${backend}`,
      backend,
      workspace_dir: snapshotPath,
    },
    paths: {
      sessionDirectory,
      databasePath,
      socketPath,
      pidPath: join(sessionDirectory, "runner.pid"),
      lockPath: join(sessionDirectory, "runner.lock"),
      configPath,
    },
    codeSha: sourceCommit,
    snapshotPath,
    codexAdapterMode: "app-server",
    ...(backend === "codex" ? { codexCliPath: fakeCli } : {}),
    claudeRuntimeV2Enabled: false,
    claudeRuntimeIdleTtlMs: 600_000,
    claudeRuntimeMaxEntries: 8,
    claudeRuntimeTurnTimeoutMs: 600_000,
    internalMcpUrl: "http://127.0.0.1:9/mcp/internal",
    codexHome: null,
    rolloutRoot: null,
  }, null, 2)}\n`, "utf8");

  const child = spawn(process.execPath, [
    join(releaseDirectory, "runner", "runner_entry.js"),
    "--config", configPath,
  ], {
    cwd: releaseDirectory,
    env: {
      ...CLEAN_AMBIENT,
      // A real host resolves the CLI path and passes it on; the fake records
      // the argv the payload's engine code used and exits.
      [cliEnvName]: fakeCli,
      ...(backend === "codex" ? { CODEX_ADAPTER_MODE: "app-server", CODEX_CLI_PATH: fakeCli } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let client;
  try {
    await waitForPath(socketPath, child, () => output);
    client = connect(socketPath);
    await once(client, "connect");
    client.setEncoding("utf8");
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        const reply = hostReplyFor(JSON.parse(line));
        if (reply) client.write(`${JSON.stringify(reply)}\n`);
      }
    });
    client.write(`${JSON.stringify({
      protocolVersion: 1,
      channel: "command",
      kind: "execute",
      commandId: `portable-release-${backend}-turn`,
      params: {
        agentSessionId: `portable-release-${backend}-session`,
        prompt: "portable release e2e",
      },
    })}\n`);
    await waitForPath(recordPath, child, () => output);
    const argv = (await readFile(recordPath, "utf8")).trim().split("\n");
    if (backend === "codex") {
      assert.equal(argv[0], "app-server", `unexpected codex argv: ${argv.join(" ")}`);
      assert.ok(
        argv.includes("stdio://"),
        `codex app-server stdio flag missing: ${argv.join(" ")}`,
      );
    } else {
      assert.ok(argv.length > 0, "the claude CLI was invoked without arguments");
    }
  } finally {
    client?.destroy();
    await stopProcess(child);
  }
  assert.doesNotMatch(output, /Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/);
}

/**
 * Minimal host answers for the request frames the child sends on this path.
 * Events and snapshots need no reply; the point is only to unblock the engine.
 */
function hostReplyFor(frame) {
  if (frame.channel !== "event" || frame.kind !== "request") return undefined;
  const { operation } = frame.request ?? {};
  const listShape = operation === "listSessions" || operation === "listSubkeys";
  return {
    protocolVersion: 1,
    channel: "control",
    kind: "response",
    correlationId: frame.correlationId,
    result: { status: "ok", data: listShape ? [] : null },
  };
}

async function readMcpPayload(response) {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0)
      .at(-1);
    assert.ok(data, `MCP SSE response carried no data line:\n${text}`);
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function waitForPath(path, child, readOutput, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    if (child.exitCode !== null) {
      throw new Error(
        `the runner child exited while waiting for ${basename(path)} `
        + `(code=${child.exitCode})\n${readOutput()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${basename(path)}\n${readOutput()}`);
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
  timer.unref();
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  return { code, signal, output };
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  const exitPromise = once(child, "exit");
  child.kill("SIGTERM");
  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref();
    }),
  ]);
  if (!exitedGracefully) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function makeDirectoriesWritable(directory) {
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => makeDirectoriesWritable(join(directory, entry.name))));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
