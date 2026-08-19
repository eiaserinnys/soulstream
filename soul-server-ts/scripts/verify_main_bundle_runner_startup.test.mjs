import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDist = join(packageRoot, "dist");
const execFileAsync = promisify(execFile);

test(
  "dist/main.js prewarms the exact manifest and stays starting until receipt ACK",
  { timeout: 20_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(packageRoot, ".tmp-main-bundle-"));
    const runnerStateDirectory = await mkdtemp(join(tmpdir(), "ss-runner-"));
    const workspaceDirectory = join(temporaryRoot, "workspace");
    const agentsConfigPath = join(temporaryRoot, "agents.yaml");
    const serviceEnvPath = join(temporaryRoot, ".env.soul-server-ts");
    const distRoot = join(temporaryRoot, "dist");
    const distMain = join(distRoot, "main.js");
    const port = await reservePort();
    let output = "";
    let child;

    try {
      await mkdir(workspaceDirectory);
      await writeFile(
        agentsConfigPath,
        [
          "agents:",
          "  - id: bundle-contract",
          "    name: Bundle Contract",
          "    backend: codex",
          `    workspace_dir: ${workspaceDirectory}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await cp(sourceDist, distRoot, { recursive: true });
      const childEnv = {
        PATH: process.env.PATH ?? "",
        HOME: temporaryRoot,
        NODE_ENV: "test",
      };
      await writeFile(serviceEnvPath, [
        "SOULSTREAM_NODE_ID=bundle-runner-startup",
        "SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:9/ws/node",
        `EVENT_OUTBOX_DIR=${join(temporaryRoot, "event-outbox")}`,
        "HOST=127.0.0.1",
        `PORT=${port}`,
        "LOG_LEVEL=error",
        `AGENTS_CONFIG_PATH=${agentsConfigPath}`,
        `AGENT_PROFILE_CACHE_PATH=${join(temporaryRoot, "agent-profile-cache.json")}`,
        `MODEL_CATALOG_PATH=${join(temporaryRoot, "missing-model-catalog.yaml")}`,
        "SOUL_RUNNER_PROCESS_ENABLED=true",
        `SOUL_RUNNER_STATE_DIR=${runnerStateDirectory}`,
        `SOUL_RUNNER_ARTIFACT_DIR=${join(distRoot, "runner")}`,
        `SOUL_RUNNER_RELEASES_DIR=${join(temporaryRoot, "releases")}`,
        "",
      ].join("\n"), "utf8");
      await execFileAsync(process.execPath, [
        join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        join(packageRoot, "scripts", "write_release_manifest.ts"),
        "--dist-root",
        distRoot,
        "--env-file",
        serviceEnvPath,
      ], { cwd: packageRoot, env: childEnv });

      child = spawn(process.execPath, [distMain], {
        cwd: temporaryRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });

      const response = await waitForHealth(child, port, () => output);
      assert.equal(response.status, 503, output);
      const health = await response.json();
      assert.equal(health.status, "starting");
      assert.equal(health.node_id, "bundle-runner-startup");
      assert.equal(health.service, "soul-server-ts");
      assert.equal(health.phase, "B-1");
      assert.equal(health.ready, false);
      assert.equal(typeof health.manifest_id, "string");
      assert.equal(health.activation_generation, null);
      assert.doesNotMatch(output, /Cannot find package ['"]sqlite['"]/);
    } finally {
      if (child && child.exitCode === null) {
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
      await makeDirectoriesWritable(temporaryRoot);
      await rm(temporaryRoot, { recursive: true, force: true });
      await rm(runnerStateDirectory, { recursive: true, force: true });
    }
  },
);

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

async function waitForHealth(child, port, readOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `dist/main.js exited before runner-on health check (code=${child.exitCode})\n${readOutput()}`,
      );
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`dist/main.js did not become healthy\n${readOutput()}`);
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
