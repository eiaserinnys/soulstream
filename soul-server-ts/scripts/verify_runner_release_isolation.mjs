import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "soulstream-runner-release-isolation-"));
let runner;
let releaseRoot;
try {
  const prewarm = await runProcess(process.execPath, [
    join(packageRoot, "dist/runner/runner_release_prewarm.js"),
    "--artifacts",
    join(packageRoot, "dist/runner"),
    "--releases",
    join(temporaryRoot, "runner-releases"),
  ], { cwd: temporaryRoot, env: sanitizedEnvironment() });
  if (prewarm.code !== 0) throw new Error(`runner prewarm failed:\n${prewarm.stderr}`);
  const release = JSON.parse(prewarm.stdout.trim());
  releaseRoot = release.release_root;
  if (!/^sha256-[a-f0-9]{64}$/.test(release.release_id)) {
    throw new Error(`runner release id is not a content hash: ${release.release_id}`);
  }
  const entries = (await readdir(release.release_root)).sort();
  const expected = [".runner-release.json", "package.json", "runner_entry.js"];
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`runner snapshot file set mismatch: ${entries.join(", ")}`);
  }

  const sessionId = "runner-release-isolation";
  const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const sessionDirectory = join(temporaryRoot, "state", slug);
  await mkdir(sessionDirectory, { recursive: true });
  const paths = {
    sessionDirectory,
    databasePath: join(sessionDirectory, "runner.sqlite"),
    socketPath: join(sessionDirectory, "runner.sock"),
    pidPath: join(sessionDirectory, "runner.pid"),
    lockPath: join(sessionDirectory, "runner.lock"),
    configPath: join(sessionDirectory, "runner-config.json"),
  };
  await writeFile(paths.configPath, JSON.stringify({
    schemaVersion: 1,
    sessionId,
    backend: "codex",
    agent: {
      id: "isolation-agent",
      name: "Isolation Agent",
      backend: "codex",
      workspace_dir: temporaryRoot,
    },
    paths,
    codeSha: release.release_id,
    snapshotPath: release.release_root,
    codexAdapterMode: "sdk",
    // CLI executables are host-provided process dependencies, not release
    // artifacts. No command is executed in this startup/IPC-close contract.
    codexCliPath: process.execPath,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1800000,
    codexHome: null,
    rolloutRoot: null,
  }));

  runner = spawn(process.execPath, [
    join(release.release_root, "runner_entry.js"),
    "--config",
    paths.configPath,
  ], {
    cwd: release.release_root,
    env: sanitizedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  runner.stderr.setEncoding("utf8");
  runner.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForPathOrExit(paths.socketPath, runner, () => stderr);
  const response = await sendLine(paths.socketPath, {
    protocolVersion: 1,
    channel: "command",
    kind: "close",
    commandId: "isolation-close",
  });
  if (
    response.channel !== "control"
    || response.kind !== "command_result"
    || response.commandId !== "isolation-close"
    || response.result?.status !== "ok"
  ) {
    throw new Error(`isolated runner close ACK mismatch: ${JSON.stringify(response)}`);
  }
  const exit = await waitForExit(runner, 5_000);
  if (exit !== 0) throw new Error(`isolated runner exited ${exit}:\n${stderr}`);
  runner = undefined;
  process.stdout.write(
    `isolated runner release verified: ${release.release_id} (${entries.join(", ")})\n`,
  );
} finally {
  runner?.kill("SIGKILL");
  if (releaseRoot) await chmod(releaseRoot, 0o755).catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function sanitizedEnvironment() {
  const env = { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" };
  delete env.INIT_CWD;
  delete env.npm_config_local_prefix;
  delete env.npm_node_execpath;
  return env;
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { code, stdout, stderr };
}

async function waitForPathOrExit(path, child, readStderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(
        `isolated runner exited before socket listen (${child.exitCode}):\n${readStderr()}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("isolated runner socket listen timed out");
}

async function sendLine(socketPath, frame) {
  return await new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("isolated runner close ACK timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      resolveResponse(JSON.parse(buffer.slice(0, newline)));
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("isolated runner shutdown timed out")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}
