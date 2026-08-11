import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedSoakConfig, ServiceEnvironments } from "./config.js";

interface ManagedPid {
  pid: number;
  entry: string;
  startedAt: string;
}

export class SoakProcessController {
  constructor(
    private readonly config: ResolvedSoakConfig,
    private readonly environments: ServiceEnvironments,
  ) {}

  async startAll(): Promise<void> {
    await this.assertBuildArtifacts();
    try {
      await this.startOrch();
      await this.startSoul();
    } catch (error) {
      await this.stopManaged(this.config.paths.soulPid).catch(() => {});
      await this.stopManaged(this.config.paths.orchPid).catch(() => {});
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    await this.stopRunners();
    await this.stopManaged(this.config.paths.soulPid);
    await this.stopManaged(this.config.paths.orchPid);
  }

  async restartSoul(): Promise<void> {
    await this.stopManaged(this.config.paths.soulPid);
    try {
      await this.startSoul();
    } catch (error) {
      await this.stopManaged(this.config.paths.soulPid).catch(() => {});
      throw error;
    }
  }

  async startOrch(): Promise<void> {
    const entry = join(this.config.repositoryRoot, "orch-server-ts", "dist", "production_main.js");
    await this.spawnManaged("orch", entry, this.environments.orch,
      this.config.paths.orchLog, this.config.paths.orchPid);
    await waitForHttp(`http://${this.config.host}:${this.config.orchPort}/api/health`, 30_000);
  }

  async startSoul(): Promise<void> {
    const entry = join(this.config.repositoryRoot, "soul-server-ts", "dist", "main.js");
    await this.spawnManaged("soul", entry, this.environments.soul,
      this.config.paths.soulLog, this.config.paths.soulPid);
    await waitForHttp(`http://${this.config.host}:${this.config.soulPort}/health`, 30_000);
  }

  async readSoulPid(): Promise<number> {
    return (await readPid(this.config.paths.soulPid)).pid;
  }

  async readRunnerPid(sessionId: string): Promise<number> {
    const { createHash } = await import("node:crypto");
    const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    const value = await readFile(join(this.config.paths.runnerState, slug, "runner.pid"), "utf8");
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid staging runner pid");
    return pid;
  }

  async assertRunnerAlive(sessionId: string, expectedPid: number): Promise<void> {
    const pid = await this.readRunnerPid(sessionId);
    if (pid !== expectedPid) {
      throw new Error(`staging runner pid changed: ${expectedPid} -> ${pid}`);
    }
    if (!isPidAlive(pid)) throw new Error(`staging runner pid ${pid} is not alive`);
    const { createHash } = await import("node:crypto");
    const slug = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    await access(join(this.config.paths.runnerState, slug, "runner.sock"));
  }

  private async assertBuildArtifacts(): Promise<void> {
    for (const path of [
      join(this.config.repositoryRoot, "orch-server-ts", "dist", "production_main.js"),
      join(this.config.repositoryRoot, "soul-server-ts", "dist", "main.js"),
      join(this.config.repositoryRoot, "soul-server-ts", "dist", "runner", "runner_entry.js"),
    ]) await access(path);
  }

  private async spawnManaged(
    name: "orch" | "soul",
    entry: string,
    serviceEnv: NodeJS.ProcessEnv,
    logPath: string,
    pidPath: string,
  ): Promise<void> {
    try {
      const existing = await readPid(pidPath);
      if (isPidAlive(existing.pid)) throw new Error(`${name} staging process already running`);
      await unlink(pidPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = openSync(logPath, "a", 0o600);
    try {
      const env = { ...process.env, ...serviceEnv };
      delete env.ANTHROPIC_API_KEY;
      const child = spawn(process.execPath, [entry], {
        cwd: this.config.paths.root,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      if (!child.pid) throw new Error(`${name} staging spawn returned no pid`);
      const record: ManagedPid = { pid: child.pid, entry, startedAt: new Date().toISOString() };
      await writeFile(pidPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      child.unref();
    } finally {
      closeSync(fd);
    }
  }

  private async stopManaged(pidPath: string): Promise<void> {
    let record: ManagedPid;
    try {
      record = await readPid(pidPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (isPidAlive(record.pid)) {
      await assertProcessIdentity(record.pid, record.entry, this.config.paths.root);
      process.kill(record.pid, "SIGTERM");
      if (!(await waitForExit(record.pid, 8_000))) {
        process.kill(record.pid, "SIGKILL");
        if (!(await waitForExit(record.pid, 2_000))) {
          throw new Error(`staging process ${record.pid} did not exit`);
        }
      }
    }
    await unlink(pidPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async stopRunners(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.config.paths.runnerState, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pidPath = join(this.config.paths.runnerState, entry.name, "runner.pid");
      try {
        const pid = Number((await readFile(pidPath, "utf8")).trim());
        if (!Number.isSafeInteger(pid) || pid <= 0 || !isPidAlive(pid)) continue;
        await assertProcessIdentity(pid, "runner_entry.js", this.config.paths.root);
        process.kill(pid, "SIGTERM");
        if (!(await waitForExit(pid, 5_000))) process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

async function readPid(path: string): Promise<ManagedPid> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ManagedPid>;
  if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || !parsed.entry) {
    throw new Error(`invalid staging pid record: ${path}`);
  }
  return parsed as ManagedPid;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function assertProcessIdentity(pid: number, entry: string, root: string): Promise<void> {
  if (process.platform !== "linux") return;
  const command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  const cwd = await readlink(`/proc/${pid}/cwd`);
  if (!command.includes(entry) || (cwd !== root && !command.includes(root))) {
    throw new Error(`refusing to signal pid ${pid}: staging process identity mismatch`);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`staging readiness timed out for ${url}`, { cause: lastError });
}
