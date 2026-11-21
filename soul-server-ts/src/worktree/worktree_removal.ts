import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { WorktreeGit, WorktreeGitError } from "./worktree_git.js";
import { WorktreeServiceError } from "./worktree_errors.js";
import { baseDependencyLinksIntoWorktree, dependencyLinksIntoWorktree, type CollectedBaseDependencyLink } from "./worktree_dependency_links.js";
import { cleanupTrashItem } from "./worktree_trash.js";
import type { WorktreeHost, WorktreeRecord, WorktreeRemovalActor } from "./worktree_types.js";

export type RemovalTimings = Record<"lockWait" | "precheck" | "beginRemove" | "rename" | "prune" | "finishRemove", number>;
export function newRemovalTimings(): RemovalTimings {
  return { lockWait: 0, precheck: 0, beginRemove: 0, rename: 0, prune: 0, finishRemove: 0 };
}
export function logRemoval(worktreeId: string, timings: RemovalTimings, outcome: string): void {
  console.info(`Worktree removal ${JSON.stringify({ worktreeId, outcome, timingsMs: timings })}`);
}
async function timed<T>(timings: RemovalTimings, phase: keyof RemovalTimings, action: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try { return await action(); } finally { timings[phase] += Date.now() - start; }
}

// Caller owns the repository lock and operation deadline for the entire lifecycle.
export async function removeWorktreeLocked(options: {
  projectsRoot: string; git: WorktreeGit; host: WorktreeHost;
  assertWorkspaceUnused: (path: string) => void;
  baseDependencyLinks?: readonly CollectedBaseDependencyLink[];
  timings?: RemovalTimings;
  lockWaitMs?: number;
}, initialRecord: WorktreeRecord, actor: WorktreeRemovalActor): Promise<WorktreeRecord> {
  let record = initialRecord;
  const timings = options.timings ?? newRemovalTimings();
  if (options.lockWaitMs !== undefined) timings.lockWait = options.lockWaitMs;
  const precheckStart = Date.now();
  let precheckFinished = false;
  let outcome = "failed";
  try {
    const missing = !existsSync(record.canonicalPath);
    const sweeper = "sweeperNodeId" in actor;
    if (!(sweeper && missing)) {
      options.assertWorkspaceUnused(record.canonicalPath);
      const links = options.baseDependencyLinks === undefined
        ? await baseDependencyLinksIntoWorktree(join(options.projectsRoot, record.repoId), record.canonicalPath)
        : dependencyLinksIntoWorktree(options.baseDependencyLinks, record.canonicalPath);
      if (links.length > 0) {
        throw new WorktreeServiceError(
          "WORKTREE_BASE_DEPENDENCY_IN_USE",
          "Base dependency links point into this worktree; repair the listed links before retrying removal",
          { links },
        );
      }
    }
    if (sweeper && missing && !record.branchDeleteExpectedSha) {
      record = { ...record, branchDeleteExpectedSha: await options.git.branchHead(record.repoId, record.branch) };
    }
    const workspaceState = await options.git.removalWorkspaceState({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
      branch: record.branch,
      expectedSha: record.branchDeleteExpectedSha,
      ...(sweeper && missing ? { allowMissingBranch: true } : {}),
    });
    if (workspaceState !== "registered" && workspaceState !== "registered_partial") {
      const expectedSha = record.branchDeleteExpectedSha;
      if (!expectedSha && !(sweeper && missing)) {
        throw new WorktreeServiceError(
          "WORKTREE_REMOVAL_HEAD_UNRECORDED",
          "The worktree registration disappeared before its branch HEAD was durably recorded",
        );
      }
      timings.precheck += Date.now() - precheckStart; precheckFinished = true;
      record = await timed(timings, "beginRemove", () => options.host.beginRemove({
        ...actor, worktreeId: record.id,
        expectedSha,
      }));
      if (workspaceState === "registered_missing") {
        await timed(timings, "prune", () => options.git.pruneMissingWorktree({
          repoId: record.repoId,
          path: record.canonicalPath,
          worktreeId: record.worktreeIdentity,
        }));
      } else if (expectedSha && !(sweeper && missing && workspaceState === "unregistered_missing")) {
        await options.git.finishPartialRemoval({
          repoId: record.repoId,
          path: record.canonicalPath,
          branch: record.branch,
          expectedSha,
        });
      }
      const result = await timed(timings, "finishRemove", () => options.host.finishRemove({ ...actor, worktreeId: record.id }));
      outcome = "removed";
      return result;
    }
    const managedPaths = record.managedPaths.map((managed) => managed.path);
    const dirty = workspaceState === "registered_partial"
      ? await options.git.inspectPartialDirty(record.repoId, record.canonicalPath, record.worktreeIdentity, managedPaths)
      : await options.git.inspectDirty(record.canonicalPath, managedPaths, undefined, { includeIgnored: false });
    if (dirty.tracked.length > 0 || dirty.untracked.length > 0) {
      throw new WorktreeServiceError(
        "WORKTREE_DIRTY",
        "Worktree contains tracked or untracked changes; preserve the listed paths and retry",
        {
          ...dirty,
          cleanup: "Commit, stash, or preserve the listed tracked and untracked paths, then retry. Ignored files, including node_modules, and the untracked root .local/ directory are removed with the worktree.",
        },
      );
    }
    const expectedSha = await options.git.removalHead({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
      branch: record.branch,
      partial: workspaceState === "registered_partial",
    });
    timings.precheck += Date.now() - precheckStart; precheckFinished = true;
    record = await timed(timings, "beginRemove", () => options.host.beginRemove({ ...actor, worktreeId: record.id, expectedSha }));
    const trashPath = await timed(timings, "rename", () => options.git.moveToTrash({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
      managedPaths: record.managedPaths,
    }));
    await timed(timings, "prune", () => options.git.pruneMissingWorktree({
      repoId: record.repoId, path: record.canonicalPath, worktreeId: record.worktreeIdentity,
    }));
    const result = await timed(timings, "finishRemove", () => options.host.finishRemove({ ...actor, worktreeId: record.id }));
    try {
      void cleanupTrashItem(options.projectsRoot, basename(trashPath)).catch((error) => {
        console.warn("Worktree trash cleanup failed", { path: trashPath, error });
      });
    } catch (error) {
      console.warn("Worktree trash cleanup failed", { path: trashPath, error });
    }
    outcome = "removed";
    return result;
  } catch (error) {
    const input = { ...actor, worktreeId: record.id };
    await options.host.restoreReady({ ...input,
      errorCode: error instanceof WorktreeServiceError || error instanceof WorktreeGitError ? error.code : "WORKTREE_REMOVE_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if ("actorSessionId" in actor && error instanceof WorktreeGitError && error.code === "MANAGED_LINK_RESTORE_FAILED") {
      await options.host.updateSetup({ actorSessionId: actor.actorSessionId, worktreeId: record.id,
        setupStatus: "failed", managedPaths: record.managedPaths });
    }
    throw error;
  } finally {
    if (!precheckFinished) timings.precheck += Date.now() - precheckStart;
    if ("sweeperNodeId" in actor) logRemoval(record.id, timings, outcome);
  }
}
