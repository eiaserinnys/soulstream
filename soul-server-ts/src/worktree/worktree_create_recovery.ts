import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  GitProcessError,
  runBoundedProcess,
  type BoundedProcessResult,
} from "./worktree_process.js";
import { WORKTREE_PARTIAL_RECOVERY_TIMEOUT_MS } from "./worktree_timeouts.js";

type ProcessRunner = typeof runBoundedProcess;
type CreationMode = "new" | "existing";
type TerminationOutcome = "timeout" | "process_failed" | "checkout_complete";

type AttemptMarker = {
  version: 1;
  attemptId: string;
  actorSessionId: string;
  worktreeId: string;
  repoId: string;
  repoPath: string;
  path: string;
  branch: string;
  mode: CreationMode;
  expectedHead: string;
};

type TerminationMarker = {
  version: 1;
  attemptId: string;
  outcome: TerminationOutcome;
  terminationConfirmed: true;
};

export type WorktreeCreationAttempt = {
  markerPath: string;
  terminationPath: string;
  marker: AttemptMarker;
};

export class WorktreePartialRecoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorktreePartialRecoveryError";
  }
}

type AttemptInput = {
  actorSessionId: string;
  worktreeId: string;
  repoId: string;
  repoPath: string;
  path: string;
  branch: string;
  mode: CreationMode;
  expectedHead: string;
  processRunner?: ProcessRunner;
};

export async function recoverPriorWorktreeCreationAttempt(input: AttemptInput): Promise<void> {
  const paths = attemptPaths(input.repoPath, input.path);
  if (existsSync(paths.markerPath) || existsSync(paths.terminationPath)) {
    await recoverPriorAttempt({ ...input, ...paths });
  }
}

export function beginWorktreeCreationAttempt(input: AttemptInput): WorktreeCreationAttempt {
  const paths = attemptPaths(input.repoPath, input.path);
  mkdirSync(paths.markerRoot, { recursive: true });
  const marker: AttemptMarker = {
    version: 1,
    attemptId: randomUUID(),
    actorSessionId: input.actorSessionId,
    worktreeId: input.worktreeId,
    repoId: input.repoId,
    repoPath: realpathSync(input.repoPath),
    path: resolve(input.path),
    branch: input.branch,
    mode: input.mode,
    expectedHead: input.expectedHead,
  };
  writeJsonExclusive(paths.markerPath, marker);
  return { markerPath: paths.markerPath, terminationPath: paths.terminationPath, marker };
}

export function markWorktreeCreationTerminated(
  attempt: WorktreeCreationAttempt,
  outcome: TerminationOutcome,
): void {
  const marker = readAttemptMarker(attempt.markerPath);
  if (marker.attemptId !== attempt.marker.attemptId) {
    throw new WorktreePartialRecoveryError(
      "WORKTREE_PARTIAL_MARKER_CHANGED",
      `Initializing marker changed for ${attempt.marker.path}`,
    );
  }
  const termination: TerminationMarker = {
    version: 1,
    attemptId: marker.attemptId,
    outcome,
    terminationConfirmed: true,
  };
  if (existsSync(attempt.terminationPath)) {
    const existing = readTerminationMarker(attempt.terminationPath);
    if (existing.attemptId === termination.attemptId) return;
    throw new WorktreePartialRecoveryError(
      "WORKTREE_PARTIAL_MARKER_CHANGED",
      `Termination marker changed for ${attempt.marker.path}`,
    );
  }
  writeJsonExclusive(attempt.terminationPath, termination);
}

export function finishWorktreeCreationAttempt(attempt: WorktreeCreationAttempt): void {
  const marker = readAttemptMarker(attempt.markerPath);
  if (marker.attemptId !== attempt.marker.attemptId) {
    throw new WorktreePartialRecoveryError(
      "WORKTREE_PARTIAL_MARKER_CHANGED",
      `Initializing marker changed for ${attempt.marker.path}`,
    );
  }
  rmSync(attempt.terminationPath, { force: true });
  rmSync(attempt.markerPath);
}

async function recoverPriorAttempt(input: {
  actorSessionId: string;
  repoId: string;
  repoPath: string;
  path: string;
  branch: string;
  mode: CreationMode;
  expectedHead: string;
  markerPath: string;
  terminationPath: string;
  processRunner?: ProcessRunner;
}): Promise<void> {
  if (!existsSync(input.markerPath) || !existsSync(input.terminationPath)) {
    throw preserved(input.path, "initializing attempt has no confirmed termination marker");
  }
  const marker = readAttemptMarker(input.markerPath);
  const termination = readTerminationMarker(input.terminationPath);
  if (
    termination.attemptId !== marker.attemptId
    || termination.terminationConfirmed !== true
    || marker.actorSessionId !== input.actorSessionId
    || marker.repoId !== input.repoId
    || !samePath(marker.repoPath, input.repoPath)
    || !samePath(marker.path, input.path)
    || marker.branch !== input.branch
    || marker.mode !== input.mode
    || marker.expectedHead !== input.expectedHead
  ) {
    throw preserved(input.path, "initializing marker does not exactly match this request");
  }

  const runner = input.processRunner ?? runBoundedProcess;
  await withRecoveryDeadline(async (signal) => {
    const runGit = async (cwd: string, args: string[], stdin?: string) =>
      await runner({
        command: "git",
        args,
        cwd,
        timeoutMs: WORKTREE_PARTIAL_RECOVERY_TIMEOUT_MS,
        signal,
        ...(stdin === undefined ? {} : { stdin }),
      });
    const entries = parsePorcelain((await runGit(
      input.repoPath,
      ["worktree", "list", "--porcelain"],
    )).stdout).filter((entry) => samePath(entry.path, input.path));
    if (entries.length > 1) {
      throw preserved(input.path, "multiple Git registrations match the initializing path");
    }
    if (entries.length === 0) {
      if (existsSync(input.path)) {
        throw preserved(input.path, "initializing path exists without one exact Git registration");
      }
      await finishBranchRecovery(input, runGit);
      removeAttemptFiles(input.markerPath, input.terminationPath, marker.attemptId);
      return;
    }

    const entry = entries[0]!;
    if (
      entry.lockedReason !== "initializing"
      || entry.branch !== input.branch
      || entry.head !== input.expectedHead
    ) {
      throw preserved(input.path, "Git registration no longer matches the initializing attempt");
    }
    if (!existsSync(input.path)) {
      throw preserved(input.path, "registered initializing path is missing");
    }
    const dirty = await inspectDirty(input.path, runGit);
    if (dirty.length > 0) {
      throw preserved(input.path, `initializing path contains files to preserve: ${dirty.join(", ")}`);
    }
    const branchHead = await readRef(input.repoPath, input.branch, runGit);
    if (branchHead !== input.expectedHead) {
      throw preserved(input.path, "branch HEAD changed before partial cleanup");
    }

    let unlockAttempted = false;
    let removed = false;
    try {
      unlockAttempted = true;
      await runGit(input.repoPath, ["worktree", "unlock", input.path]);
      const afterUnlockDirty = await inspectDirty(input.path, runGit);
      if (afterUnlockDirty.length > 0) {
        throw preserved(input.path, `initializing path changed during cleanup: ${afterUnlockDirty.join(", ")}`);
      }
      await runGit(input.repoPath, ["worktree", "remove", input.path]);
      removed = true;
      const remaining = parsePorcelain((await runGit(
        input.repoPath,
        ["worktree", "list", "--porcelain"],
      )).stdout).filter((candidate) => samePath(candidate.path, input.path));
      if (remaining.length > 0 || existsSync(input.path)) {
        throw new WorktreePartialRecoveryError(
          "WORKTREE_PARTIAL_CLEANUP_INCOMPLETE",
          `Non-force cleanup did not remove the exact initializing worktree: ${input.path}`,
        );
      }
      await finishBranchRecovery(input, runGit);
      removeAttemptFiles(input.markerPath, input.terminationPath, marker.attemptId);
    } catch (error) {
      if (unlockAttempted && !removed) {
        try {
          await ensureInitializingLock(input, runner);
        } catch (relockError) {
          throw new WorktreePartialRecoveryError(
            "WORKTREE_PARTIAL_RELOCK_FAILED",
            `Partial cleanup failed and the exact worktree could not be re-locked: ${input.path}`,
            relockError,
          );
        }
      }
      if (removed) {
        throw new WorktreePartialRecoveryError(
          "WORKTREE_PARTIAL_BRANCH_PRESERVED",
          `The partial worktree was removed, but its branch or marker was preserved: ${input.branch}`,
          error,
        );
      }
      throw error;
    }
  });
}

async function ensureInitializingLock(
  input: { repoPath: string; path: string; branch: string; expectedHead: string },
  runner: ProcessRunner,
): Promise<void> {
  if (!existsSync(input.path)) {
    throw unconfirmedSafety("the initializing path disappeared while restoring its lock");
  }
  const readExactEntry = async () => {
    let result: BoundedProcessResult;
    try {
      result = await runner({
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        cwd: input.repoPath,
        timeoutMs: WORKTREE_PARTIAL_RECOVERY_TIMEOUT_MS,
      });
    } catch {
      throw unconfirmedSafety("the initializing Git registration could not be re-read");
    }
    const entries = parsePorcelain(result.stdout).filter((entry) => samePath(entry.path, input.path));
    if (entries.length !== 1) {
      throw unconfirmedSafety("the initializing path no longer has one exact Git registration");
    }
    const entry = entries[0]!;
    if (entry.branch !== input.branch || entry.head !== input.expectedHead) {
      throw unconfirmedSafety("the initializing Git registration changed while restoring its lock");
    }
    return entry;
  };

  let entry = await readExactEntry();
  if (entry.lockedReason === "initializing") return;
  if (entry.lockedReason !== undefined) {
    throw new Error(`the initializing Git registration has a different lock: ${entry.lockedReason}`);
  }

  let lastRelockError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runner({
        command: "git",
        args: ["worktree", "lock", "--reason", "initializing", input.path],
        cwd: input.repoPath,
        timeoutMs: WORKTREE_PARTIAL_RECOVERY_TIMEOUT_MS,
      });
      lastRelockError = undefined;
    } catch (error) {
      lastRelockError = error;
    }
    entry = await readExactEntry();
    if (entry.lockedReason === "initializing") return;
    if (entry.lockedReason !== undefined) {
      throw new Error(`the initializing Git registration has a different lock: ${entry.lockedReason}`);
    }
    if (
      lastRelockError !== undefined
      && (!(lastRelockError instanceof GitProcessError) || !lastRelockError.terminationConfirmed)
    ) {
      throw unconfirmedSafety("the re-lock process did not terminate conclusively");
    }
  }
  throw unconfirmedSafety("the initializing Git registration remained unlocked after re-lock retries");
}

function unconfirmedSafety(message: string): GitProcessError {
  return new GitProcessError("PROCESS_TIMEOUT", message, false);
}

async function finishBranchRecovery(
  input: { mode: CreationMode; repoPath: string; branch: string; expectedHead: string },
  runGit: (cwd: string, args: string[], stdin?: string) => Promise<BoundedProcessResult>,
): Promise<void> {
  if (input.mode !== "new") return;
  const current = await readRef(input.repoPath, input.branch, runGit);
  if (current === null) return;
  if (current !== input.expectedHead) {
    throw new WorktreePartialRecoveryError(
      "WORKTREE_PARTIAL_REF_REUSED",
      `Partial branch was reused and was preserved: ${input.branch}`,
    );
  }
  await runGit(
    input.repoPath,
    ["update-ref", "--stdin"],
    `delete refs/heads/${input.branch} ${input.expectedHead}\n`,
  );
}

async function inspectDirty(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<BoundedProcessResult>,
): Promise<string[]> {
  const status = await runGit(path, [
    "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal",
  ]);
  const ignored = await runGit(path, [
    "ls-files", "--others", "-i", "--exclude-standard", "-z",
  ]);
  return [...status.stdout.split("\0"), ...ignored.stdout.split("\0")]
    .filter(Boolean)
    .map((entry) => entry.length > 3 && entry[2] === " " ? entry.slice(3) : entry);
}

async function readRef(
  repo: string,
  branch: string,
  runGit: (cwd: string, args: string[]) => Promise<BoundedProcessResult>,
): Promise<string | null> {
  try {
    const result = await runGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof GitProcessError && error.code === "PROCESS_FAILED") return null;
    throw error;
  }
}

async function withRecoveryDeadline<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKTREE_PARTIAL_RECOVERY_TIMEOUT_MS);
  timer.unref();
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function attemptPaths(repoPath: string, path: string) {
  const markerRoot = join(realpathSync(join(repoPath, ".git")), "soulstream-worktree-attempts");
  const key = createHash("sha256").update(resolve(path)).digest("hex");
  const markerPath = join(markerRoot, `${key}.json`);
  return {
    markerRoot,
    markerPath,
    terminationPath: join(markerRoot, `${key}.terminated.json`),
  };
}

function writeJsonExclusive(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", flush: true });
}

function readAttemptMarker(path: string): AttemptMarker {
  const value = readJson(path);
  if (
    value.version !== 1
    || typeof value.attemptId !== "string"
    || typeof value.actorSessionId !== "string"
    || typeof value.worktreeId !== "string"
    || typeof value.repoId !== "string"
    || typeof value.repoPath !== "string"
    || typeof value.path !== "string"
    || typeof value.branch !== "string"
    || (value.mode !== "new" && value.mode !== "existing")
    || typeof value.expectedHead !== "string"
  ) throw preserved(path, "invalid initializing marker");
  return value as AttemptMarker;
}

function readTerminationMarker(path: string): TerminationMarker {
  const value = readJson(path);
  if (
    value.version !== 1
    || typeof value.attemptId !== "string"
    || !["timeout", "process_failed", "checkout_complete"].includes(String(value.outcome))
    || value.terminationConfirmed !== true
  ) throw preserved(path, "invalid termination marker");
  return value as TerminationMarker;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid evidence must be preserved for explicit operator inspection.
  }
  throw preserved(path, "unreadable initializing marker");
}

function removeAttemptFiles(markerPath: string, terminationPath: string, attemptId: string): void {
  const marker = readAttemptMarker(markerPath);
  const termination = readTerminationMarker(terminationPath);
  if (marker.attemptId !== attemptId || termination.attemptId !== attemptId) {
    throw preserved(marker.path, "initializing evidence changed during cleanup");
  }
  rmSync(terminationPath);
  rmSync(markerPath);
}

type PorcelainEntry = {
  path: string;
  head: string;
  branch?: string;
  lockedReason?: string;
};

function parsePorcelain(output: string): PorcelainEntry[] {
  return output.trim().split(/\n\n+/).filter(Boolean).flatMap((block) => {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      fields.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
    }
    const path = fields.get("worktree");
    const head = fields.get("HEAD");
    if (!path || !head) return [];
    const branch = fields.get("branch")?.replace(/^refs\/heads\//, "");
    return [{
      path: resolve(path),
      head,
      ...(branch ? { branch } : {}),
      ...(fields.has("locked") ? { lockedReason: fields.get("locked") ?? "" } : {}),
    }];
  });
}

function preserved(path: string, reason: string): WorktreePartialRecoveryError {
  return new WorktreePartialRecoveryError(
    "WORKTREE_PARTIAL_PRESERVED",
    `Preserved initializing worktree ${path}: ${reason}`,
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
