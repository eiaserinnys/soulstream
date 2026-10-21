import { existsSync } from "node:fs";
import { join } from "node:path";

import { baseDependencyLinksIntoWorktree } from "./worktree_dependency_links.js";
import { WorktreeGit } from "./worktree_git.js";
import { removeWorktreeLocked } from "./worktree_removal.js";
import { RepositoryLock } from "./worktree_repository_lock.js";
import { decideWorktreeSweep, SWEEP_RECENT_MS, type SweepOutcome } from "./worktree_sweep_policy.js";
import type { WorktreeHost, WorktreeSweepCandidate } from "./worktree_types.js";

interface SweepOptions {
  nodeId: string;
  projectsRoot: string;
  git: WorktreeGit;
  host: WorktreeHost;
  lock: RepositoryLock;
  createTimeoutMs: number;
  assertWorkspaceUnused: (path: string) => void;
}

export async function sweepWorktrees(options: SweepOptions, input: {
  now?: number;
  onFetchError?: (repoId: string, error: unknown) => void;
}) {
  const candidates = await options.host.sweepCandidates({ nodeId: options.nodeId });
  const result = {
    candidates: candidates.length,
    removed: 0, recent: 0, in_use: 0, base_links: 0, changes: 0,
    unpushed: 0, not_finished: 0, failed: 0,
    removedWorktreeIds: [] as string[],
    errors: [] as Array<{ worktreeId: string; message: string }>,
  };
  const fetched = new Set<string>();
  for (const candidate of candidates) {
    try {
      const outcome = await options.git.withOperationDeadline(async () => {
        const commonDirectory = await options.git.commonDirectory(candidate.repoId);
        return await options.lock.withLock(commonDirectory, async () =>
          await sweepCandidate(options, candidate, fetched, input));
      }, options.createTimeoutMs);
      result[outcome]++;
      if (outcome === "removed") result.removedWorktreeIds.push(candidate.id);
    } catch (error) {
      if (errorCode(error) === "WORKTREE_IN_USE") result.in_use++;
      else {
        result.failed++;
        result.errors.push({ worktreeId: candidate.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return result;
}

async function sweepCandidate(
  options: SweepOptions,
  record: WorktreeSweepCandidate,
  fetched: Set<string>,
  input: { now?: number; onFetchError?: (repoId: string, error: unknown) => void },
): Promise<SweepOutcome> {
  const gitActivity = await options.git.lastWorktreeActivityMs(record.repoId, record.canonicalPath);
  const idleMs = (input.now ?? Date.now()) - Math.max(new Date(record.lastSessionActivityAt).getTime(), gitActivity);
  if (idleMs < SWEEP_RECENT_MS) return "recent";
  const actor = { sweeperNodeId: options.nodeId };
  if (!existsSync(record.canonicalPath)) {
    await removeWorktreeLocked(options, record, actor);
    return "removed";
  }
  options.assertWorkspaceUnused(record.canonicalPath);
  const links = await baseDependencyLinksIntoWorktree(join(options.projectsRoot, record.repoId), record.canonicalPath);
  if (links.length) return "base_links";
  const dirty = await options.git.inspectDirty(record.canonicalPath, record.managedPaths.map(path => path.path));
  if (dirty.tracked.length || dirty.untracked.length) return "changes";
  if (!fetched.has(record.repoId)) {
    fetched.add(record.repoId);
    try {
      await options.git.fetchOrigin(record.repoId);
    } catch (error) {
      input.onFetchError?.(record.repoId, error);
    }
  }
  const head = await options.git.removalHead({
    repoId: record.repoId, path: record.canonicalPath,
    worktreeId: record.worktreeIdentity, branch: record.branch,
  });
  const state = await options.git.sweepCommitState(record.repoId, head);
  const outcome = decideWorktreeSweep({ idleMs, missing: false, inUse: false, baseLinks: false,
    changes: false, ...state, linkedCardsClosed: record.linkedCardsClosed });
  if (outcome === "removed") await removeWorktreeLocked(options, record, actor);
  return outcome;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
