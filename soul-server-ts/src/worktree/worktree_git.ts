import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from "node:fs";

// This module intentionally exceeds 500 lines: it is the single Git mutation
// boundary whose identity, ref-CAS, and non-force removal invariants must stay
// visible together. Timeout-partial recovery is split into its own tested module.
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { GitProcessError, runBoundedProcess } from "./worktree_process.js";
import {
  beginWorktreeCreationAttempt,
  finishWorktreeCreationAttempt,
  markWorktreeCreationTerminated,
  recoverPriorWorktreeCreationAttempt,
} from "./worktree_create_recovery.js";
export { WORKTREE_OPERATION_TIMEOUT_MS } from "./worktree_timeouts.js";

const IDENTITY_FILE = "soulstream-worktree-id";

export class WorktreeGitError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorktreeGitError";
  }
}

export interface WorktreeListEntry {
  path: string;
  head: string;
  branch?: string;
  kind: "base" | "managed" | "unmanaged" | "external" | "missing";
  identity?: string;
  lockedReason?: string;
}

export interface WorktreeDirtyState {
  clean: boolean;
  tracked: string[];
  untracked: string[];
  ignored: string[];
}

export type WorktreeRemovalWorkspaceState =
  | "registered"
  | "registered_missing"
  | "unregistered_missing"
  | "unregistered_empty";

export class WorktreeGit {
  private readonly projectsRoot: string;
  private readonly operationSignal = new AsyncLocalStorage<AbortSignal>();

  constructor(private readonly options: {
    projectsRoot: string;
    timeoutMs: number;
    createTimeoutMs?: number;
    processRunner?: typeof runBoundedProcess;
  }) {
    this.projectsRoot = realpathSync(options.projectsRoot);
  }

  async withOperationDeadline<T>(
    action: () => Promise<T>,
    timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    if (this.operationSignal.getStore()) return await action();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      return await this.operationSignal.run(controller.signal, action);
    } finally {
      clearTimeout(timer);
    }
  }

  async create(input: {
    actorSessionId: string;
    repoId: string;
    branch: string;
    mode: "new" | "existing";
    worktreeId: string;
    startPoint?: string;
  }): Promise<WorktreeListEntry> {
    const repo = this.resolveRepository(input.repoId);
    await this.validateBranch(repo, input.branch);
    const suffix = createHash("sha256").update(input.branch).digest("hex").slice(0, 8);
    const slug = input.branch
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "worktree";
    const path = join(this.projectsRoot, `${basename(repo)}--${slug}-${suffix}`);
    const hasOrigin = await this.hasRemote(repo, "origin");
    if (hasOrigin) await this.git(repo, ["fetch", "--prune", "origin"]);
    let args: string[];
    let expectedHead: string;
    if (input.mode === "new") {
      const startPoint = input.startPoint
        ?? (hasOrigin ? "refs/remotes/origin/HEAD" : "HEAD");
      expectedHead = (await this.git(
        repo,
        ["rev-parse", "--verify", `${startPoint}^{commit}`],
      )).stdout.trim();
      await recoverPriorWorktreeCreationAttempt({
        ...input,
        repoPath: repo,
        path,
        expectedHead,
        processRunner: this.options.processRunner,
      });
      if (
        await this.refSha(repo, `refs/heads/${input.branch}`)
        || await this.refSha(repo, `refs/remotes/origin/${input.branch}`)
      ) {
        throw new WorktreeGitError("BRANCH_ALREADY_EXISTS", input.branch);
      }
      args = ["worktree", "add", "-b", input.branch, path, expectedHead];
    } else {
      const localHead = await this.refSha(repo, `refs/heads/${input.branch}`);
      const remoteHead = localHead === null
        ? await this.refSha(repo, `refs/remotes/origin/${input.branch}`)
        : null;
      expectedHead = localHead ?? remoteHead ?? "";
      if (!expectedHead) throw new WorktreeGitError("BRANCH_NOT_FOUND", input.branch);
      await recoverPriorWorktreeCreationAttempt({
        ...input,
        repoPath: repo,
        path,
        expectedHead,
        processRunner: this.options.processRunner,
      });
      if (await this.refSha(repo, `refs/heads/${input.branch}`)) {
        args = ["worktree", "add", path, input.branch];
      } else if (await this.refSha(repo, `refs/remotes/origin/${input.branch}`)) {
        args = [
          "worktree", "add", "--track", "-b", input.branch,
          path, `refs/remotes/origin/${input.branch}`,
        ];
      } else {
        throw new WorktreeGitError("BRANCH_NOT_FOUND", input.branch);
      }
    }
    if (existsSync(path)) {
      throw new WorktreeGitError("WORKTREE_PATH_EXISTS", `Worktree path already exists: ${path}`);
    }
    const attempt = beginWorktreeCreationAttempt({
      ...input,
      repoPath: repo,
      path,
      expectedHead,
      processRunner: this.options.processRunner,
    });
    try {
      await this.git(repo, args, this.options.createTimeoutMs ?? this.options.timeoutMs);
      markWorktreeCreationTerminated(attempt, "checkout_complete");
      const gitDir = await this.privateGitDirectory(path);
      writeFileSync(join(gitDir, IDENTITY_FILE), `${input.worktreeId}\n`, { flag: "wx" });
      const entry = (await this.list(input.repoId)).find(
        (candidate) => candidate.path === realpathSync(path),
      );
      if (!entry) throw new WorktreeGitError("WORKTREE_CREATE_UNDISCOVERABLE", path);
      finishWorktreeCreationAttempt(attempt);
      return entry;
    } catch (error) {
      if (error instanceof GitProcessError && error.terminationConfirmed) {
        markWorktreeCreationTerminated(
          attempt,
          error.code === "PROCESS_TIMEOUT" ? "timeout" : "process_failed",
        );
      }
      throw error;
    }
  }

  async commonDirectory(repoId: string): Promise<string> {
    const repo = this.resolveRepository(repoId);
    const raw = (await this.git(repo, ["rev-parse", "--git-common-dir"])).stdout.trim();
    return realpathSync(isAbsolute(raw) ? raw : resolve(repo, raw));
  }

  listRepositoryIds(): string[] {
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const gitPath = join(this.projectsRoot, entry.name, ".git");
        return existsSync(gitPath) && lstatSync(gitPath).isDirectory();
      })
      .map((entry) => entry.name)
      .sort();
  }

  async adopt(input: {
    repoId: string;
    path: string;
    branch: string;
    expectedHead: string;
    worktreeId: string;
  }): Promise<WorktreeListEntry> {
    const repo = this.resolveRepository(input.repoId);
    await this.validateBranch(repo, input.branch);
    const candidate = realpathSync(input.path);
    this.assertPathInsideProjectsRoot(candidate);
    const entries = await this.list(input.repoId);
    const entry = entries.find((item) => item.path === candidate);
    if (!entry || entry.kind !== "unmanaged") {
      throw new WorktreeGitError("WORKTREE_NOT_ADOPTABLE", candidate);
    }
    if (entry.lockedReason !== undefined) {
      throw new WorktreeGitError("WORKTREE_LOCKED", candidate);
    }
    if (entry.head !== input.expectedHead) {
      throw new WorktreeGitError("WORKTREE_HEAD_CHANGED", `${entry.head} != ${input.expectedHead}`);
    }
    if (entry.branch !== input.branch) {
      throw new WorktreeGitError(
        "WORKTREE_BRANCH_MISMATCH",
        `${entry.branch ?? "detached"} != ${input.branch}`,
      );
    }
    const gitDir = await this.privateGitDirectory(candidate);
    writeFileSync(join(gitDir, IDENTITY_FILE), `${input.worktreeId}\n`, { flag: "wx" });
    return { ...entry, kind: "managed", identity: input.worktreeId };
  }

  async remove(input: {
    repoId: string;
    path: string;
    worktreeId: string;
    managedPaths: Array<{ path: string; target: string }>;
  }): Promise<void> {
    const repo = this.resolveRepository(input.repoId);
    const path = realpathSync(input.path);
    await this.assertIdentity(path, input.worktreeId);
    const links: Array<{ path: string; target: string }> = [];
    for (const managed of input.managedPaths) {
      const managedPath = safeManagedPath(path, managed.path);
      if (!existsSync(managedPath)) continue;
      const stat = lstatSync(managedPath);
      if (!stat.isSymbolicLink()) {
        throw new WorktreeGitError("MANAGED_PATH_CHANGED", managed.path);
      }
      const target = realpathSync(managedPath);
      if (target !== realpathSync(managed.target)) {
        throw new WorktreeGitError("MANAGED_PATH_CHANGED", managed.path);
      }
      links.push({ path: managedPath, target });
    }
    for (const link of links) rmSync(link.path, { force: true });
    try {
      await this.git(repo, ["worktree", "remove", path]);
      await this.git(repo, ["worktree", "prune"]);
    } catch (error) {
      try {
        for (const link of links) {
          if (!existsSync(link.path)) {
            symlinkSync(link.target, link.path, process.platform === "win32" ? "junction" : "dir");
          }
        }
      } catch (restoreError) {
        throw new WorktreeGitError(
          "MANAGED_LINK_RESTORE_FAILED",
          `Git removal failed and shared dependency links could not be restored: ${String(restoreError)}`,
          error,
        );
      }
      throw error;
    }
  }

  async removalWorkspaceState(input: {
    repoId: string;
    path: string;
    worktreeId: string;
    branch: string;
    expectedSha: string | null;
  }): Promise<WorktreeRemovalWorkspaceState> {
    const repo = this.resolveRepository(input.repoId);
    const path = resolve(input.path);
    this.assertPathInsideProjectsRoot(path);
    const registration = await this.rawRegistration(repo, path);
    const pathStat = lstatIfPresent(path);
    if (registration) {
      const admin = await this.registrationAdmin(input.repoId, path);
      if (admin?.identity !== input.worktreeId) {
        throw new WorktreeGitError(
          "WORKTREE_IDENTITY_CHANGED",
          `Expected worktree ${input.worktreeId}, found ${admin?.identity || "unmanaged"}`,
        );
      }
      if (!pathStat) {
        this.assertRecordedRemovalHead(input.expectedSha);
        if (registration.branch !== input.branch) {
          throw new WorktreeGitError(
            "WORKTREE_BRANCH_MISMATCH",
            `${registration.branch ?? "detached"} != ${input.branch}`,
          );
        }
        if (registration.head !== input.expectedSha) {
          throw new WorktreeGitError(
            "WORKTREE_HEAD_CHANGED",
            `${registration.head} != ${input.expectedSha}`,
          );
        }
        await this.assertBranchHead(input.repoId, input.branch, input.expectedSha);
        return "registered_missing";
      }
      if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
        throw new WorktreeGitError(
          "WORKTREE_UNAVAILABLE",
          `Registered worktree path is not a directory: ${path}`,
        );
      }
      const privateGitDirectory = await this.privateGitDirectory(path);
      if (!samePath(privateGitDirectory, admin.path)) {
        throw new WorktreeGitError(
          "WORKTREE_IDENTITY_CHANGED",
          `Registered worktree metadata changed for ${path}`,
        );
      }
      return "registered";
    }
    this.assertRecordedRemovalHead(input.expectedSha);
    await this.assertBranchHead(input.repoId, input.branch, input.expectedSha);
    if (!pathStat) return "unregistered_missing";
    this.assertEmptyRemovalResidue(path, pathStat);
    return "unregistered_empty";
  }

  async finishPartialRemoval(input: {
    repoId: string;
    path: string;
    branch: string;
    expectedSha: string;
  }): Promise<void> {
    const repo = this.resolveRepository(input.repoId);
    const path = resolve(input.path);
    this.assertPathInsideProjectsRoot(path);
    if (await this.rawRegistration(repo, path)) {
      throw new WorktreeGitError(
        "WORKTREE_REGISTRATION_CHANGED",
        `Worktree registration reappeared for ${path}`,
      );
    }
    await this.assertBranchHead(input.repoId, input.branch, input.expectedSha);
    const before = lstatIfPresent(path);
    if (!before) return;
    this.assertEmptyRemovalResidue(path, before);

    // Recheck all mutable identities immediately before removing only the empty leaf directory.
    if (await this.rawRegistration(repo, path)) {
      throw new WorktreeGitError(
        "WORKTREE_REGISTRATION_CHANGED",
        `Worktree registration reappeared for ${path}`,
      );
    }
    await this.assertBranchHead(input.repoId, input.branch, input.expectedSha);
    const current = lstatIfPresent(path);
    if (!current || current.dev !== before.dev || current.ino !== before.ino) {
      throw new WorktreeGitError(
        "WORKTREE_PARTIAL_REMOVE_RESIDUE",
        `Worktree residue changed during removal: ${path}`,
      );
    }
    this.assertEmptyRemovalResidue(path, current);
    try {
      rmdirSync(path);
    } catch (error) {
      throw new WorktreeGitError(
        "WORKTREE_PARTIAL_REMOVE_CLEANUP_FAILED",
        `Could not remove the verified empty worktree residue: ${path}`,
        error,
      );
    }
  }

  async pruneMissingWorktree(input: {
    repoId: string;
    path: string;
    worktreeId: string;
  }): Promise<void> {
    const repo = this.resolveRepository(input.repoId);
    const path = resolve(input.path);
    this.assertPathInsideProjectsRoot(path);
    if (existsSync(path)) {
      throw new WorktreeGitError("WORKTREE_PATH_REAPPEARED", path);
    }
    const commonDirectory = await this.commonDirectory(input.repoId);
    const adminRoot = join(commonDirectory, "worktrees");
    let matched = false;
    if (existsSync(adminRoot)) {
      for (const admin of readdirSync(adminRoot, { withFileTypes: true })) {
        if (!admin.isDirectory()) continue;
        const adminPath = join(adminRoot, admin.name);
        const gitdirFile = join(adminPath, "gitdir");
        if (!existsSync(gitdirFile)) continue;
        const worktreeGitFile = readFileSync(gitdirFile, "utf8").trim();
        const registeredPath = resolve(worktreeGitFile, "..");
        if (!samePath(registeredPath, path)) continue;
        matched = true;
        const marker = join(adminPath, IDENTITY_FILE);
        const identity = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
        if (identity !== input.worktreeId) {
          throw new WorktreeGitError(
            "WORKTREE_IDENTITY_CHANGED",
            `Expected worktree ${input.worktreeId}, found ${identity || "unmanaged"}`,
          );
        }
      }
    }
    const listed = (await this.list(input.repoId)).some((entry) => samePath(entry.path, path));
    if (!matched && !listed) return;
    if (!matched) {
      throw new WorktreeGitError("WORKTREE_IDENTITY_CHANGED", `Missing identity for ${path}`);
    }
    await this.git(repo, ["worktree", "prune", "--expire", "now"]);
    if ((await this.list(input.repoId)).some((entry) => samePath(entry.path, path))) {
      throw new WorktreeGitError("WORKTREE_PRUNE_FAILED", path);
    }
  }

  async branchHead(repoId: string, branch: string): Promise<string | null> {
    const repo = this.resolveRepository(repoId);
    try {
      return (await this.git(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]))
        .stdout.trim();
    } catch (error) {
      rethrowProcessTimeout(error);
      return null;
    }
  }

  async removalHead(input: {
    repoId: string;
    path: string;
    worktreeId: string;
    branch: string;
  }): Promise<string> {
    const path = realpathSync(input.path);
    await this.assertIdentity(path, input.worktreeId);
    const entry = (await this.list(input.repoId)).find((candidate) => candidate.path === path);
    if (!entry || entry.identity !== input.worktreeId) {
      throw new WorktreeGitError("WORKTREE_UNAVAILABLE", path);
    }
    if (entry.branch !== input.branch) {
      throw new WorktreeGitError(
        "WORKTREE_BRANCH_MISMATCH",
        `${entry.branch ?? "detached"} != ${input.branch}`,
      );
    }
    const branchHead = await this.branchHead(input.repoId, input.branch);
    if (branchHead !== entry.head) {
      throw new WorktreeGitError(
        "WORKTREE_HEAD_CHANGED",
        `${branchHead ?? "missing"} != ${entry.head}`,
      );
    }
    return entry.head;
  }

  async deleteBranch(input: {
    repoId: string;
    branch: string;
    expectedSha: string;
    markerRef: string;
  }): Promise<"deleted" | "already_deleted"> {
    const repo = this.resolveRepository(input.repoId);
    await this.validateBranch(repo, input.branch);
    try {
      await this.git(repo, ["fetch", "--prune", "origin"]);
    } catch (error) {
      rethrowProcessTimeout(error);
      throw new WorktreeGitError("REMOTE_FETCH_FAILED", input.repoId);
    }
    const markerSha = await this.refSha(repo, input.markerRef);
    if (markerSha === input.expectedSha) return "already_deleted";
    const current = await this.branchHead(input.repoId, input.branch);
    if (current !== input.expectedSha) {
      throw new WorktreeGitError("REF_REUSED", `${current ?? "missing"} != ${input.expectedSha}`);
    }
    if (!await this.isCommitPreserved(repo, input.expectedSha, input.branch)) {
      throw new WorktreeGitError("UNPRESERVED_COMMITS", input.branch);
    }
    const checkedOut = (await this.list(input.repoId)).some(
      (entry) => entry.branch === input.branch,
    );
    if (checkedOut) throw new WorktreeGitError("BRANCH_CHECKED_OUT", input.branch);
    const script = [
      "start",
      `create ${input.markerRef} ${input.expectedSha}`,
      `delete refs/heads/${input.branch} ${input.expectedSha}`,
      "prepare",
      "commit",
      "",
    ].join("\n");
    await this.gitWithInput(repo, ["update-ref", "--stdin"], script);
    return "deleted";
  }

  async resolveManagedWorkspace(input: {
    repoId: string;
    path: string;
    worktreeId: string;
  }): Promise<string> {
    const path = realpathSync(input.path);
    this.assertPathInsideProjectsRoot(path);
    await this.assertIdentity(path, input.worktreeId);
    const registered = (await this.list(input.repoId)).some(
      (entry) => entry.path === path && entry.identity === input.worktreeId,
    );
    if (!registered) throw new WorktreeGitError("WORKTREE_UNAVAILABLE", path);
    return path;
  }

  async list(repoId: string): Promise<WorktreeListEntry[]> {
    const repo = this.resolveRepository(repoId);
    const base = realpathSync(repo);
    const output = (await this.git(repo, ["worktree", "list", "--porcelain"])).stdout;
    const entries: WorktreeListEntry[] = [];
    for (const block of output.trim().split(/\n\n+/).filter(Boolean)) {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const space = line.indexOf(" ");
        fields.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
      }
      const rawPath = fields.get("worktree");
      const head = fields.get("HEAD");
      if (!rawPath || !head) continue;
      const pathExists = existsSync(rawPath);
      const path = pathExists ? realpathSync(rawPath) : resolve(rawPath);
      const branchRef = fields.get("branch");
      const lockedReason = fields.has("locked") ? fields.get("locked") ?? "" : undefined;
      const identity = pathExists ? await this.readIdentity(path) : undefined;
      const insideProjectsRoot = isPathInside(this.projectsRoot, path);
      entries.push({
        path,
        head,
        ...(branchRef ? { branch: branchRef.replace(/^refs\/heads\//, "") } : {}),
        kind: !pathExists
          ? "missing"
          : path === base
          ? "base"
          : !insideProjectsRoot
            ? "external"
            : identity
              ? "managed"
              : "unmanaged",
        ...(identity ? { identity } : {}),
        ...(lockedReason !== undefined ? { lockedReason } : {}),
      });
    }
    return entries;
  }

  async inspectDirty(path: string, managedPaths: string[]): Promise<WorktreeDirtyState> {
    this.assertPathInsideProjectsRoot(path);
    const privateGitDirectory = await this.privateGitDirectory(path);
    const exactWorktree = ["--git-dir", privateGitDirectory, "--work-tree", resolve(path)];
    const status = (await this.git(path, [
      ...exactWorktree,
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=normal",
    ])).stdout.split("\0").filter(Boolean);
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const entry of status) {
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code === "??") untracked.push(file);
      else tracked.push(file);
    }
    const ignored = (await this.git(path, [
      ...exactWorktree,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ])).stdout.split("\0").filter(Boolean);
    const unmanagedTracked = tracked.filter((entry) => !isManagedEntry(entry, managedPaths));
    const unmanagedUntracked = untracked.filter((entry) => !isManagedEntry(entry, managedPaths));
    const unmanagedIgnored = ignored.filter((entry) => !isManagedEntry(entry, managedPaths));
    return {
      clean: unmanagedTracked.length === 0
        && unmanagedUntracked.length === 0
        && unmanagedIgnored.length === 0,
      tracked: unmanagedTracked,
      untracked: unmanagedUntracked,
      ignored: unmanagedIgnored,
    };
  }

  async isIgnored(path: string, relativePath: string): Promise<boolean> {
    this.assertPathInsideProjectsRoot(path);
    try {
      await this.git(path, ["check-ignore", "-q", "--", relativePath]);
      return true;
    } catch (error) {
      if (error instanceof GitProcessError && error.exitCode === 1) return false;
      throw error;
    }
  }

  async assertIdentity(path: string, expected: string): Promise<void> {
    this.assertPathInsideProjectsRoot(path);
    const actual = await this.readIdentity(path);
    if (actual !== expected) {
      throw new WorktreeGitError(
        "WORKTREE_IDENTITY_CHANGED",
        `Expected worktree ${expected}, found ${actual ?? "unmanaged"}`,
      );
    }
  }

  private resolveRepository(repoId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(repoId)) {
      throw new WorktreeGitError("INVALID_REPO_ID", `Invalid repo_id: ${repoId}`);
    }
    const candidate = join(this.projectsRoot, repoId);
    this.assertPathInsideProjectsRoot(candidate);
    const gitPath = join(candidate, ".git");
    if (
      !existsSync(candidate)
      || !statSync(candidate).isDirectory()
      || !existsSync(gitPath)
      || !lstatSync(gitPath).isDirectory()
    ) {
      throw new WorktreeGitError("REPOSITORY_NOT_FOUND", candidate);
    }
    return realpathSync(candidate);
  }

  private assertPathInsideProjectsRoot(path: string): void {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.projectsRoot, path);
    const rel = relative(this.projectsRoot, absolute);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
    throw new WorktreeGitError("PATH_OUTSIDE_PROJECTS_ROOT", absolute);
  }

  private async privateGitDirectory(worktree: string): Promise<string> {
    const dotGit = join(worktree, ".git");
    const stat = lstatIfPresent(dotGit);
    if (!stat || stat.isSymbolicLink()) {
      throw new WorktreeGitError("WORKTREE_UNAVAILABLE", `Missing .git metadata: ${worktree}`);
    }
    if (stat.isDirectory()) return realpathSync(dotGit);
    if (!stat.isFile()) {
      throw new WorktreeGitError("WORKTREE_UNAVAILABLE", `Invalid .git metadata: ${worktree}`);
    }
    const match = /^gitdir:\s*(.+)\s*$/u.exec(readFileSync(dotGit, "utf8").trim());
    if (!match) {
      throw new WorktreeGitError("WORKTREE_UNAVAILABLE", `Invalid .git metadata: ${worktree}`);
    }
    const raw = match[1]!;
    return realpathSync(isAbsolute(raw) ? raw : resolve(worktree, raw));
  }

  private async rawRegistration(repo: string, path: string): Promise<{
    head: string;
    branch?: string;
  } | undefined> {
    const output = (await this.git(repo, ["worktree", "list", "--porcelain"])).stdout;
    const matches = output.trim().split(/\n\n+/).filter(Boolean).flatMap((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const space = line.indexOf(" ");
        fields.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
      }
      const rawPath = fields.get("worktree");
      const head = fields.get("HEAD");
      if (!rawPath || !head || !samePath(rawPath, path)) return [];
      const branchRef = fields.get("branch");
      return [{
        head,
        ...(branchRef ? { branch: branchRef.replace(/^refs\/heads\//, "") } : {}),
      }];
    });
    if (matches.length > 1) {
      throw new WorktreeGitError("WORKTREE_REGISTRATION_CHANGED", `Duplicate registration: ${path}`);
    }
    return matches[0];
  }

  private async registrationAdmin(repoId: string, path: string): Promise<{
    path: string;
    identity?: string;
  } | undefined> {
    const commonDirectory = await this.commonDirectory(repoId);
    const adminRoot = join(commonDirectory, "worktrees");
    if (!existsSync(adminRoot)) return undefined;
    const matches: Array<{ path: string; identity?: string }> = [];
    for (const admin of readdirSync(adminRoot, { withFileTypes: true })) {
      if (!admin.isDirectory()) continue;
      const adminPath = join(adminRoot, admin.name);
      const gitdirFile = join(adminPath, "gitdir");
      if (!existsSync(gitdirFile)) continue;
      const registeredPath = resolve(readFileSync(gitdirFile, "utf8").trim(), "..");
      if (!samePath(registeredPath, path)) continue;
      const marker = join(adminPath, IDENTITY_FILE);
      matches.push({
        path: adminPath,
        ...(existsSync(marker)
          ? { identity: readFileSync(marker, "utf8").trim() || undefined }
          : {}),
      });
    }
    if (matches.length > 1) {
      throw new WorktreeGitError("WORKTREE_REGISTRATION_CHANGED", `Duplicate admin entry: ${path}`);
    }
    return matches[0];
  }

  private assertRecordedRemovalHead(expectedSha: string | null): asserts expectedSha is string {
    if (!expectedSha) {
      throw new WorktreeGitError(
        "WORKTREE_REMOVAL_HEAD_UNRECORDED",
        "The worktree registration disappeared before its branch HEAD was durably recorded",
      );
    }
  }

  private async assertBranchHead(repoId: string, branch: string, expectedSha: string): Promise<void> {
    const branchHead = await this.branchHead(repoId, branch);
    if (branchHead !== expectedSha) {
      throw new WorktreeGitError(
        "WORKTREE_HEAD_CHANGED",
        `${branchHead ?? "missing"} != ${expectedSha}`,
      );
    }
  }

  private assertEmptyRemovalResidue(
    path: string,
    stat: Stats,
  ): void {
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(path).length !== 0) {
      throw new WorktreeGitError(
        "WORKTREE_PARTIAL_REMOVE_RESIDUE",
        `Partial worktree removal left files or a non-directory at ${path}; preserve it and retry after manual inspection`,
      );
    }
  }

  private async readIdentity(worktree: string): Promise<string | undefined> {
    try {
      const gitDir = await this.privateGitDirectory(worktree);
      const marker = join(gitDir, IDENTITY_FILE);
      return existsSync(marker) ? readFileSync(marker, "utf8").trim() || undefined : undefined;
    } catch (error) {
      rethrowProcessTimeout(error);
      return undefined;
    }
  }

  private async git(cwd: string, args: string[], timeoutMs = this.options.timeoutMs) {
    return await (this.options.processRunner ?? runBoundedProcess)({
      command: "git",
      args,
      cwd,
      timeoutMs,
      signal: this.operationSignal.getStore(),
    });
  }

  private async gitWithInput(cwd: string, args: string[], input: string) {
    return await (this.options.processRunner ?? runBoundedProcess)({
      command: "git",
      args,
      cwd,
      timeoutMs: this.options.timeoutMs,
      stdin: input,
      signal: this.operationSignal.getStore(),
    });
  }

  private async refSha(repo: string, ref: string): Promise<string | null> {
    try {
      return (await this.git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    } catch (error) {
      rethrowProcessTimeout(error);
      return null;
    }
  }

  private async hasRemote(repo: string, remote: string): Promise<boolean> {
    try {
      await this.git(repo, ["remote", "get-url", remote]);
      return true;
    } catch (error) {
      rethrowProcessTimeout(error);
      return false;
    }
  }

  private async validateBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.git(repo, ["check-ref-format", "--branch", branch]);
    } catch (error) {
      rethrowProcessTimeout(error);
      throw new WorktreeGitError("INVALID_BRANCH", branch);
    }
  }

  private async isCommitPreserved(repo: string, sha: string, branch: string): Promise<boolean> {
    const remote = await this.refSha(repo, `refs/remotes/origin/${branch}`);
    if (remote === sha) return true;
    try {
      await this.git(repo, ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/HEAD"]);
      return true;
    } catch (error) {
      rethrowProcessTimeout(error);
      return false;
    }
  }
}

function rethrowProcessTimeout(error: unknown): void {
  if (error instanceof GitProcessError && error.code === "PROCESS_TIMEOUT") throw error;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function isManagedEntry(entry: string, managedPaths: string[]): boolean {
  const normalized = entry.replaceAll("\\", "/").replace(/\/$/, "");
  return managedPaths.some((managedPath) => {
    const managed = managedPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === managed || normalized.startsWith(`${managed}/`);
  });
}

function safeManagedPath(worktree: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new WorktreeGitError("INVALID_MANAGED_PATH", relativePath);
  }
  const candidate = resolve(worktree, relativePath);
  const rel = relative(worktree, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorktreeGitError("INVALID_MANAGED_PATH", relativePath);
  }
  return candidate;
}
