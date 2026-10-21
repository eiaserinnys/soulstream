import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorktreeGit, WorktreeGitError } from "./worktree_git.js";
import { WorktreeServiceError } from "./worktree_service.js";
import { baseDependencyLinksIntoWorktree, dependencyLinksIntoWorktree, type CollectedBaseDependencyLink } from "./worktree_dependency_links.js";
import type { WorktreeHost, WorktreeRecord, WorktreeRemovalActor } from "./worktree_types.js";

// Caller owns the repository lock and operation deadline for the entire lifecycle.
export async function removeWorktreeLocked(options: {
  projectsRoot: string; git: WorktreeGit; host: WorktreeHost;
  assertWorkspaceUnused: (path: string) => void;
  baseDependencyLinks?: readonly CollectedBaseDependencyLink[];
}, initialRecord: WorktreeRecord, actor: WorktreeRemovalActor): Promise<WorktreeRecord> {
  let record = initialRecord;
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
    if (workspaceState !== "registered") {
      const expectedSha = record.branchDeleteExpectedSha;
      if (!expectedSha && !(sweeper && missing)) {
        throw new WorktreeServiceError(
          "WORKTREE_REMOVAL_HEAD_UNRECORDED",
          "The worktree registration disappeared before its branch HEAD was durably recorded",
        );
      }
      record = await options.host.beginRemove({
        ...actor, worktreeId: record.id,
        expectedSha,
      });
      if (workspaceState === "registered_missing") {
        await options.git.pruneMissingWorktree({
          repoId: record.repoId,
          path: record.canonicalPath,
          worktreeId: record.worktreeIdentity,
        });
      } else if (expectedSha && !(sweeper && missing && workspaceState === "unregistered_missing")) {
        await options.git.finishPartialRemoval({
          repoId: record.repoId,
          path: record.canonicalPath,
          branch: record.branch,
          expectedSha,
        });
      }
      return await options.host.finishRemove({ ...actor, worktreeId: record.id });
    }
    const dirty = await options.git.inspectDirty(
      record.canonicalPath,
      record.managedPaths.map((managed) => managed.path),
    );
    if (dirty.tracked.length > 0 || dirty.untracked.length > 0) {
      throw new WorktreeServiceError(
        "WORKTREE_DIRTY",
        "Worktree contains tracked or untracked changes; preserve the listed paths and retry",
        {
          ...dirty,
          cleanup: "Commit, stash, or preserve the listed tracked and untracked paths, then retry. Ignored files, including node_modules, are removed with the worktree.",
        },
      );
    }
    const expectedSha = await options.git.removalHead({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
      branch: record.branch,
    });
    record = await options.host.beginRemove({ ...actor, worktreeId: record.id, expectedSha });
    await options.git.removeIgnored({ path: record.canonicalPath, ignored: dirty.ignored });
    await options.git.remove({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
      managedPaths: record.managedPaths,
    });
    return await options.host.finishRemove({ ...actor, worktreeId: record.id });
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
  }
}
