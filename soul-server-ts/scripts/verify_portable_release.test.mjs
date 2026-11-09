import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..");
const portableDist = join(packageRoot, "dist-portable");
const hostDist = join(packageRoot, "dist");
const execFileAsync = promisify(execFile);
/** Ambient env a bare `node main.js` gets: no credentials, no release document, no npm. */
const CLEAN_AMBIENT = { PATH: process.env.PATH ?? "", HOME: tmpdir() };

let temporaryRoot;
let releaseDirectory;
let tamperedDirectory;
let appRoot;
let envFile;
let packSummary;
let sourceCommit;

before(async () => {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  await assertPortableBuild();
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
  const pack = await execFileAsync(process.execPath, [
    join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    join(packageRoot, "scripts", "pack_portable_release.ts"),
    "--out", outRoot,
    "--source-commit", sourceCommit,
  ], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 });
  packSummary = JSON.parse(pack.stdout.trim().split("\n").at(-1));
  assert.equal(packSummary.source_commit, sourceCommit);

  releaseDirectory = join(temporaryRoot, "release");
  await mkdir(releaseDirectory, { recursive: true });
  await execFileAsync("tar", ["-xzf", packSummary.tarball, "-C", releaseDirectory]);
  envFile = join(releaseDirectory, ".env.soul-server-ts");
  const port = await reservePort();
  await writeFile(envFile, [
    "SOULSTREAM_NODE_ID=portable-release-e2e",
    "SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:9/ws/node",
    `EVENT_OUTBOX_DIR=${join(appRoot, "event-outbox")}`,
    `PORT=${port}`,
    "HOST=127.0.0.1",
    "LOG_LEVEL=error",
    `AGENTS_CONFIG_PATH=${join(appRoot, "agents.yaml")}`,
    `AGENT_PROFILE_CACHE_PATH=${join(appRoot, "agent-profile-cache.json")}`,
    `MODEL_CATALOG_PATH=${join(appRoot, "missing-model-catalog.yaml")}`,
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
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.equal(bind.code, 0, bind.output);
  assert.match(bind.output, /^bind-release: bound [0-9a-f]{40} manifest=sha256-[0-9a-f]{64} /m);

  const manifest = JSON.parse(await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"));
  assert.equal(manifest.source_commit, sourceCommit);
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
  assert.deepEqual(entries, [".runner-release.json", "package.json", "runner_entry.js"]);

  // No --config: the entry fails on its own contract, but only after the whole
  // bundled module graph loaded. A leftover bare import would fail earlier.
  const entry = await runProcess(process.execPath, [
    join(releaseDirectory, "runner", "runner_entry.js"),
  ], { cwd: releaseDirectory, env: CLEAN_AMBIENT, timeoutMs: 60_000 });
  assert.notEqual(entry.code, 0);
  assert.match(entry.output, /runner entry requires --config/);
  assert.doesNotMatch(entry.output, /Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/);
});

async function assertPortableBuild() {
  for (const [directory, relativePath] of [
    [portableDist, "main.js"],
    [portableDist, "runner/runner_release_prewarm.js"],
    [portableDist, "upstream/control_inbox_worker_entry.js"],
    [portableDist, "bind-release.mjs"],
    [join(packageRoot, "dist", "runner"), "runner_entry.js"],
    [join(packageRoot, "dist", "runner"), "package.json"],
    [hostDist, "release-manifest.json"],
  ]) {
    if (!await exists(join(directory, relativePath))) {
      throw new Error(`${join(directory, relativePath)} is missing: run \`pnpm run build\` `
        + "and `pnpm run build:portable` first");
    }
  }
}

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
