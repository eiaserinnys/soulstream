import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  NodeGitCloneJob,
  NodeGitError,
  NodeGitRepoSummary,
  NodeGitSetupSnapshot,
  NodeGitSshCheckResult,
} from "@soulstream/wire-schema";

import { GitProcessError, type runBoundedProcess } from "../worktree/worktree_process.js";
import { isPathInside, listRepositoryIds } from "../worktree/worktree_repository_scan.js";
import { NodeGitCloneJobs } from "./node_git_clone_jobs.js";
import {
  NodeGitServiceError,
  deriveRepoName,
  parseCloneId,
  parseCloneUrl,
  parseHost,
  parseIdentity,
  parseRepoName,
} from "./node_git_validation.js";

type ProcessRunner = typeof runBoundedProcess;

export interface NodeGitServiceOptions {
  nodeId: string;
  homeDir: string;
  projectsRoot: string | null;
  env: NodeJS.ProcessEnv;
  processRunner: ProcessRunner;
}

const GIT_TIMEOUT_MS = 5_000;
const SSH_KEYGEN_TIMEOUT_MS = 10_000;
const SSH_CHECK_TIMEOUT_MS = 15_000;
const CLONE_TIMEOUT_MS = 1_200_000;
const REPO_INSPECT_CONCURRENCY = 4;
const REPO_STATUS_MAX_STDOUT_BYTES = 65_536;
const PUBLIC_KEY_MAX_BYTES = 16 * 1024;
const PUBLIC_KEY_PREFIX = "ssh-ed25519 ";
const SSH_OUTPUT_MAX_CHARS = 300;
const CLONE_DETAIL_MAX_CHARS = 2_000;

type ProjectsSnapshot = NodeGitSetupSnapshot["projects"];

export class NodeGitService {
  private readonly jobs = new NodeGitCloneJobs();

  constructor(private readonly options: NodeGitServiceOptions) {}

  async status(): Promise<NodeGitSetupSnapshot> {
    const [identity, ssh, projects] = await Promise.all([
      this.readIdentity(),
      this.readSsh(),
      this.readProjects(),
    ]);
    return { identity, ssh, projects, clone: this.jobs.latest() };
  }

  async setIdentity(input: { name: unknown; email: unknown }): Promise<NodeGitSetupSnapshot> {
    const { name, email } = parseIdentity(input);
    await this.git(["config", "--global", "user.name", name], this.options.homeDir);
    await this.git(["config", "--global", "user.email", email], this.options.homeDir);
    return await this.status();
  }

  async createSshKey(): Promise<NodeGitSetupSnapshot> {
    const privatePath = this.privateKeyPath();
    await mkdir(join(this.options.homeDir, ".ssh"), { recursive: true, mode: 0o700 });
    if (await exists(privatePath) || await exists(`${privatePath}.pub`)) {
      throw new NodeGitServiceError("ssh_key_exists", "An SSH key already exists on this node");
    }
    try {
      await this.run({
        command: "ssh-keygen",
        args: ["-q", "-t", "ed25519", "-N", "", "-C", `soulstream@${this.options.nodeId}`, "-f", privatePath],
        cwd: this.options.homeDir,
        timeoutMs: SSH_KEYGEN_TIMEOUT_MS,
      });
    } catch (error) {
      throw new NodeGitServiceError(
        isNotInstalled(error) ? "ssh_not_installed" : "ssh_key_create_failed",
        isNotInstalled(error) ? "ssh-keygen is not installed" : "ssh-keygen failed",
      );
    }
    return await this.status();
  }

  async checkSsh(input: { host: unknown }): Promise<NodeGitSshCheckResult> {
    const host = parseHost(input.host);
    try {
      const result = await this.run({
        command: "ssh",
        args: [
          "-T",
          "-o", "BatchMode=yes",
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "ConnectTimeout=10",
          `git@${host}`,
        ],
        cwd: this.options.homeDir,
        timeoutMs: SSH_CHECK_TIMEOUT_MS,
        acceptedExitCodes: [0, 1, 255],
      });
      const output = firstLine(result.stderr, result.stdout);
      if (result.exitCode !== 255) return { host, ok: true, reason: "connected", output };
      return { host, ok: false, reason: classifySshFailure(`${result.stderr}\n${result.stdout}`), output };
    } catch (error) {
      if (isNotInstalled(error)) {
        throw new NodeGitServiceError("ssh_not_installed", "ssh is not installed");
      }
      if (error instanceof GitProcessError && error.code === "PROCESS_TIMEOUT") {
        return { host, ok: false, reason: "unreachable", output: "timed out" };
      }
      return { host, ok: false, reason: "failed", output: firstLine(error instanceof GitProcessError ? error.stderr ?? "" : "") };
    }
  }

  async startClone(input: { url: unknown; repo_name?: unknown }): Promise<NodeGitCloneJob> {
    const url = parseCloneUrl(input.url);
    const repoName = input.repo_name === undefined ? deriveRepoName(url) : parseRepoName(input.repo_name);
    const projects = await this.readProjects();
    if (projects.state !== "ready" || projects.root === null) {
      throw new NodeGitServiceError("projects_root_unavailable", "The projects folder is not available on this node");
    }
    const root = projects.root;
    const target = join(root, repoName);
    assertInsideRoot(root, target);
    if (await exists(target)) {
      throw new NodeGitServiceError("repo_exists", "A folder with this name already exists", "repo_name");
    }
    if (this.jobs.running()) {
      throw new NodeGitServiceError("clone_busy", "Another clone is already running");
    }
    const job = this.jobs.start({ repoName, url });
    void this.runClone(job.clone_id, url, root, target);
    return job;
  }

  cloneStatus(input: { clone_id: unknown }): NodeGitCloneJob {
    const job = this.jobs.get(parseCloneId(input.clone_id));
    if (!job) throw new NodeGitServiceError("clone_not_found", "No such clone job");
    return job;
  }

  private async runClone(cloneId: string, url: string, root: string, target: string): Promise<void> {
    let failure: NodeGitError | null = null;
    try {
      await this.run({
        command: "git",
        args: ["clone", "--", url, target],
        cwd: root,
        timeoutMs: CLONE_TIMEOUT_MS,
        env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
      });
    } catch (error) {
      failure = classifyCloneFailure(error);
      await this.removeFailedClone(root, target);
    }
    this.jobs.finish(cloneId, failure);
  }

  private async removeFailedClone(root: string, target: string): Promise<void> {
    try {
      assertInsideRoot(root, target);
      if (await exists(target)) await rm(target, { recursive: true, force: true });
    } catch {
      // 정리에 실패해도 클론 실패 보고가 우선이다. 남은 폴더는 다음 클론에서 repo_exists로 드러난다.
    }
  }

  private async readIdentity(): Promise<NodeGitSetupSnapshot["identity"]> {
    const [name, email] = await Promise.all([
      this.readGitConfig("user.name"),
      this.readGitConfig("user.email"),
    ]);
    return { name, email };
  }

  private async readGitConfig(key: string): Promise<string | null> {
    const result = await this.git(["config", "--global", "--get", key], this.options.homeDir, [0, 1]);
    const value = result.stdout.trim();
    return value === "" ? null : value;
  }

  private privateKeyPath(): string {
    return join(this.options.homeDir, ".ssh", "id_ed25519");
  }

  private async readSsh(): Promise<NodeGitSetupSnapshot["ssh"]> {
    const keyPath = this.privateKeyPath();
    const publicKey = await readPublicKey(`${keyPath}.pub`);
    if (publicKey !== null) return { state: "ready", key_path: keyPath, public_key: publicKey };
    // 비밀키는 있는지만 본다. 내용을 읽거나 응답에 담지 않는다.
    return { state: await exists(keyPath) ? "public_missing" : "missing", key_path: keyPath, public_key: null };
  }

  private async readProjects(): Promise<ProjectsSnapshot> {
    const configured = this.options.projectsRoot;
    if (configured === null) return { state: "root_unset", root: null, repos: [] };
    let root: string;
    try {
      root = await realpath(configured);
      if (!(await stat(root)).isDirectory()) return { state: "root_missing", root: configured, repos: [] };
    } catch {
      return { state: "root_missing", root: configured, repos: [] };
    }
    const repos = await mapWithConcurrency(listRepositoryIds(root), REPO_INSPECT_CONCURRENCY, (name) =>
      this.inspectRepository(join(root, name), name),
    );
    return { state: "ready", root, repos };
  }

  private async inspectRepository(repoPath: string, name: string): Promise<NodeGitRepoSummary> {
    try {
      const [origin, status] = await Promise.all([
        this.git(["config", "--get", "remote.origin.url"], repoPath, [0, 1]),
        this.git(["status", "--porcelain=v2", "--branch", "--untracked-files=no"], repoPath, [0], REPO_STATUS_MAX_STDOUT_BYTES),
      ]);
      const originUrl = origin.stdout.trim();
      const lines = status.stdout.split("\n").filter((line) => line !== "");
      const head = lines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length).trim();
      return {
        name,
        origin_url: originUrl === "" ? null : originUrl,
        branch: head === undefined || head === "(detached)" ? null : head,
        dirty: status.truncated === true || lines.some((line) => !line.startsWith("#")),
      };
    } catch (error) {
      if (isNotInstalled(error)) throw gitNotInstalled();
      return { name, origin_url: null, branch: null, dirty: true };
    }
  }

  private async git(
    args: string[],
    cwd: string,
    acceptedExitCodes?: number[],
    maxStdoutBytes?: number,
  ): ReturnType<ProcessRunner> {
    try {
      return await this.run({
        command: "git",
        args,
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(acceptedExitCodes ? { acceptedExitCodes } : {}),
        ...(maxStdoutBytes ? { maxStdoutBytes } : {}),
      });
    } catch (error) {
      if (isNotInstalled(error)) throw gitNotInstalled();
      throw error;
    }
  }

  private run(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    acceptedExitCodes?: number[];
    maxStdoutBytes?: number;
  }): ReturnType<ProcessRunner> {
    return this.options.processRunner({
      ...input,
      env: {
        ...this.options.env,
        ...input.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        LC_ALL: "C",
      },
    });
  }
}

function gitNotInstalled(): NodeGitServiceError {
  return new NodeGitServiceError("git_not_installed", "git is not installed on this node");
}

function isNotInstalled(error: unknown): boolean {
  return error instanceof GitProcessError && error.code === "PROCESS_START_FAILED" && /ENOENT/.test(error.message);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPublicKey(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > PUBLIC_KEY_MAX_BYTES) return null;
    const text = (await readFile(path, "utf8")).trim();
    return text.startsWith(PUBLIC_KEY_PREFIX) ? text : null;
  } catch {
    return null;
  }
}

function assertInsideRoot(root: string, target: string): void {
  if (target === root || !isPathInside(root, target)) {
    throw new NodeGitServiceError("invalid_request", "target is outside the projects folder", "repo_name");
  }
}

function firstLine(...texts: string[]): string {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "");
    if (line !== undefined) return line.slice(0, SSH_OUTPUT_MAX_CHARS);
  }
  return "";
}

function classifySshFailure(text: string): NodeGitSshCheckResult["reason"] {
  if (text.includes("Permission denied")) return "auth_failed";
  if (/Could not resolve|timed out|Connection refused/.test(text)) return "unreachable";
  if (text.includes("Host key verification failed")) return "host_key_mismatch";
  return "failed";
}

function classifyCloneFailure(error: unknown): NodeGitError {
  if (error instanceof GitProcessError) {
    if (error.code === "PROCESS_TIMEOUT") {
      return { code: "clone_timeout", message: "The clone took too long and was stopped" };
    }
    const stderr = error.stderr ?? error.message;
    const detail = stderr.slice(-CLONE_DETAIL_MAX_CHARS);
    if (/Permission denied \(publickey\)|Authentication failed|could not read Username/.test(stderr)) {
      return { code: "auth_failed", message: "Authentication failed", detail };
    }
    if (/Repository not found|not found/.test(stderr)) {
      return { code: "repo_not_found", message: "Repository was not found", detail };
    }
    if (/Could not resolve host/.test(stderr)) {
      return { code: "unreachable", message: "The host could not be reached", detail };
    }
    return { code: "clone_failed", message: "git clone failed", detail };
  }
  return { code: "clone_failed", message: "git clone failed" };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
