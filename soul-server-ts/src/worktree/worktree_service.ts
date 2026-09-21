import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { WorktreeExecutionResolver } from "../task/task_executor.js";
import { WorktreeGit, WorktreeGitError } from "./worktree_git.js";
import { RepositoryLock } from "./worktree_repository_lock.js";
import type {
  ManagedWorktreePath,
  WorktreeHost,
  WorktreeRecord,
  WorktreeSetupMode,
} from "./worktree_types.js";

export class WorktreeServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorktreeServiceError";
  }
}

export interface CreateWorktreeInput {
  actorSessionId: string;
  repoId: string;
  branch: string;
  mode: "new" | "existing" | "adopt";
  startPoint?: string;
  adoptPath?: string;
  expectedHead?: string;
  setup: WorktreeSetupMode;
  requireSetup: boolean;
}

export class WorktreeService implements WorktreeExecutionResolver {
  constructor(private readonly options: {
    nodeId: string;
    projectsRoot: string;
    git: WorktreeGit;
    lock: RepositoryLock;
    host: WorktreeHost;
    listActiveWorkspaceDirs: () => string[];
  }) {}

  async list(input: {
    actorSessionId: string;
    repoId?: string;
    worktreeId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    const repositories = input.repoId
      ? [input.repoId]
      : this.options.git.listRepositoryIds();
    const records = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    });
    const byPath = new Map(records.map((record) => [record.canonicalPath, record]));
    const observedAt = new Date().toISOString();
    const result: Array<Record<string, unknown>> = [];
    const discoveredRecordIds = new Set<string>();
    for (const repoId of repositories) {
      for (const discovered of await this.options.git.list(repoId)) {
        const record = byPath.get(discovered.path);
        if (input.worktreeId && record?.id !== input.worktreeId) continue;
        if (record) discoveredRecordIds.add(record.id);
        const dirty = discovered.kind === "base"
          ? { clean: true, tracked: [], untracked: [], ignored: [] }
          : await this.options.git.inspectDirty(
              discovered.path,
              record?.managedPaths.map((managed) => managed.path) ?? [],
            );
        result.push({
          worktreeId: record?.id ?? null,
          nodeId: this.options.nodeId,
          repoId,
          path: discovered.path,
          branch: discovered.branch ?? null,
          head: discovered.head,
          discoveryKind: discovered.kind === "unmanaged"
            ? "unmanaged_adoptable"
            : discovered.kind === "external"
              ? "unmanaged_external"
              : discovered.kind,
          dirty,
          dbState: record?.state ?? null,
          ownerKind: record ? (record.ownerTaskId ? "task" : "session") : null,
          ownerId: record?.ownerTaskId ?? record?.createdBySessionId ?? null,
          mutableByCaller: record?.mutableByCaller ?? false,
          adoptionAllowed: discovered.kind === "unmanaged",
          activeSessionId: record?.activeSessionId ?? null,
          remoteStatus: "unknown",
          observedAt,
        });
      }
    }
    for (const record of records) {
      if (discoveredRecordIds.has(record.id)) continue;
      result.push({
        worktreeId: record.id,
        nodeId: record.nodeId,
        repoId: record.repoId,
        path: record.canonicalPath,
        branch: record.branch,
        head: record.createdFromSha,
        discoveryKind: "managed_missing",
        dirty: null,
        dbState: record.state,
        ownerKind: record.ownerTaskId ? "task" : "session",
        ownerId: record.ownerTaskId ?? record.createdBySessionId,
        mutableByCaller: record.mutableByCaller ?? false,
        adoptionAllowed: false,
        activeSessionId: record.activeSessionId ?? null,
        remoteStatus: "unknown",
        observedAt,
      });
    }
    return result;
  }

  async create(input: CreateWorktreeInput): Promise<Record<string, unknown>> {
    validateCreateInput(input);
    const knownRecords = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      repoId: input.repoId,
    });
    const existing = knownRecords.find((record) =>
      record.branch === input.branch
      && record.state === "ready"
      && record.mutableByCaller === true);
    if (existing) {
      await this.options.git.resolveManagedWorkspace({
        repoId: existing.repoId,
        path: existing.canonicalPath,
        worktreeId: existing.worktreeIdentity,
      });
      if (existing.setupMode !== input.setup || existing.setupRequired !== input.requireSetup) {
        throw new WorktreeServiceError(
          "WORKTREE_SETUP_CONTRACT_MISMATCH",
          "Existing worktree setup contract differs from the request",
        );
      }
      if (existing.setupStatus !== "failed") return createResult(existing, true, false, []);
      const commonDirectory = await this.options.git.commonDirectory(input.repoId);
      return await this.options.lock.withLock(commonDirectory, async () => {
        const setup = setupSharedDependencies({
          projectsRoot: this.options.projectsRoot,
          repoId: input.repoId,
          worktreePath: existing.canonicalPath,
          mode: existing.setupMode,
        });
        const updated = await this.options.host.updateSetup({
          actorSessionId: input.actorSessionId,
          worktreeId: existing.id,
          setupStatus: setup.status,
          managedPaths: setup.managedPaths,
        });
        return createResult(updated, true, false, setup.warnings);
      });
    }

    const worktreeId = randomUUID();
    const commonDirectory = await this.options.git.commonDirectory(input.repoId);
    return await this.options.lock.withLock(commonDirectory, async () => {
      const currentRecords = await this.options.host.list({
        actorSessionId: input.actorSessionId,
        nodeId: this.options.nodeId,
        repoId: input.repoId,
      });
      const orphan = (await this.options.git.list(input.repoId)).find((entry) =>
        entry.kind === "managed"
        && entry.branch === input.branch
        && entry.identity
        && !currentRecords.some((record) =>
          record.id === entry.identity || record.canonicalPath === entry.path));
      if (orphan) {
        if (input.mode === "adopt") {
          const adoptPath = realpathSync(input.adoptPath!);
          if (adoptPath !== orphan.path || input.expectedHead !== orphan.head) {
            throw new WorktreeServiceError(
              "WORKTREE_RECOVERY_MISMATCH",
              "The orphaned managed worktree no longer matches the adoption request",
            );
          }
        }
        const setup = setupSharedDependencies({
          projectsRoot: this.options.projectsRoot,
          repoId: input.repoId,
          worktreePath: orphan.path,
          mode: input.setup,
        });
        const recovered = await this.options.host.register({
          actorSessionId: input.actorSessionId,
          id: orphan.identity!,
          nodeId: this.options.nodeId,
          repoId: input.repoId,
          canonicalPath: orphan.path,
          branch: input.branch,
          createdFromSha: orphan.head,
          setupMode: input.setup,
          setupRequired: input.requireSetup,
          setupStatus: setup.status,
          managedPaths: setup.managedPaths,
          worktreeIdentity: orphan.identity!,
        });
        return createResult(recovered, true, input.mode === "adopt", setup.warnings, true);
      }
      const created = input.mode === "adopt"
        ? await this.adopt(input, worktreeId)
        : await this.options.git.create({
            repoId: input.repoId,
            branch: input.branch,
            mode: input.mode,
            worktreeId,
            ...(input.startPoint ? { startPoint: input.startPoint } : {}),
          });
      const setup = setupSharedDependencies({
        projectsRoot: this.options.projectsRoot,
        repoId: input.repoId,
        worktreePath: created.path,
        mode: input.setup,
      });
      const record = await this.options.host.register({
        actorSessionId: input.actorSessionId,
        id: worktreeId,
        nodeId: this.options.nodeId,
        repoId: input.repoId,
        canonicalPath: created.path,
        branch: input.branch,
        createdFromSha: created.head,
        setupMode: input.setup,
        setupRequired: input.requireSetup,
        setupStatus: setup.status,
        managedPaths: setup.managedPaths,
        worktreeIdentity: worktreeId,
      });
      return createResult(record, false, input.mode === "adopt", setup.warnings);
    });
  }

  async remove(input: { actorSessionId: string; worktreeId: string }): Promise<Record<string, unknown>> {
    const record = await this.options.host.beginRemove(input);
    if (record.state === "removed") return { worktreeId: record.id, removed: true, reused: true };
    const commonDirectory = await this.options.git.commonDirectory(record.repoId);
    try {
      await this.options.lock.withLock(commonDirectory, async () => {
        if (!existsSync(record.canonicalPath)) return;
        await this.options.git.assertIdentity(record.canonicalPath, record.worktreeIdentity);
        const dirty = await this.options.git.inspectDirty(
          record.canonicalPath,
          record.managedPaths.map((managed) => managed.path),
        );
        if (!dirty.clean) {
          throw new WorktreeServiceError(
            "WORKTREE_DIRTY",
            "Worktree contains tracked, untracked, or ignored files; clean the listed paths and retry",
            {
              ...dirty,
              cleanup: "Commit, stash, or manually remove only the listed paths, then retry. Real node_modules directories are never removed automatically.",
            },
          );
        }
        await this.options.git.remove({
          repoId: record.repoId,
          path: record.canonicalPath,
          worktreeId: record.worktreeIdentity,
          managedPaths: record.managedPaths,
        });
      });
    } catch (error) {
      await this.options.host.restoreReady({
        ...input,
        errorCode: errorCode(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const removed = await this.options.host.finishRemove(input);
    return { worktreeId: removed.id, removed: true, branch: removed.branch };
  }

  async deleteBranch(input: { actorSessionId: string; worktreeId: string }) {
    const [record] = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      worktreeId: input.worktreeId,
    });
    if (!record || !record.mutableByCaller) {
      throw new WorktreeServiceError("WORKTREE_NOT_OWNED", input.worktreeId);
    }
    if (record.state !== "removed") {
      throw new WorktreeServiceError("WORKTREE_NOT_REMOVED", input.worktreeId);
    }
    if (record.branchDeletedAt) return { worktreeId: record.id, deleted: true, reused: true };
    const commonDirectory = await this.options.git.commonDirectory(record.repoId);
    return await this.options.lock.withLock(commonDirectory, async () => {
      const expectedSha = record.branchDeleteExpectedSha
        ?? await this.options.git.branchHead(record.repoId, record.branch);
      if (!expectedSha) {
        if (record.branchDeleteMarkerRef) {
          await this.options.host.finishBranchDelete(input);
          return { worktreeId: record.id, deleted: true, reused: true };
        }
        throw new WorktreeServiceError("BRANCH_NOT_FOUND", record.branch);
      }
      const markerRef = record.branchDeleteMarkerRef
        ?? `refs/soulstream/worktree-deletions/${record.id}`;
      await this.options.host.beginBranchDelete({ ...input, expectedSha, markerRef });
      await this.options.git.deleteBranch({
        repoId: record.repoId,
        branch: record.branch,
        expectedSha,
        markerRef,
      });
      await this.options.host.finishBranchDelete(input);
      return { worktreeId: record.id, branch: record.branch, deleted: true };
    });
  }

  async resolveExecutionWorkspace(worktreeId: string): Promise<string> {
    const record = await this.options.host.resolveExecution({
      worktreeId,
      nodeId: this.options.nodeId,
    });
    return await this.options.git.resolveManagedWorkspace({
      repoId: record.repoId,
      path: record.canonicalPath,
      worktreeId: record.worktreeIdentity,
    });
  }

  private async adopt(input: CreateWorktreeInput, worktreeId: string) {
    const path = realpathSync(input.adoptPath!);
    for (const active of this.options.listActiveWorkspaceDirs()) {
      const activePath = realpathSync(active);
      if (overlaps(path, activePath)) {
        throw new WorktreeServiceError("WORKTREE_IN_USE", path);
      }
    }
    return await this.options.git.adopt({
      repoId: input.repoId,
      path,
      expectedHead: input.expectedHead!,
      worktreeId,
    });
  }
}

function validateCreateInput(input: CreateWorktreeInput): void {
  if (input.mode !== "new" && input.startPoint) {
    throw new WorktreeServiceError("INVALID_REQUEST", "start_point is new-mode only");
  }
  if (input.mode === "adopt" && (!input.adoptPath || !input.expectedHead)) {
    throw new WorktreeServiceError("INVALID_REQUEST", "adopt_path and expected_head are required");
  }
}

function setupSharedDependencies(input: {
  projectsRoot: string;
  repoId: string;
  worktreePath: string;
  mode: WorktreeSetupMode;
}): { status: "not_requested" | "ready" | "failed"; managedPaths: ManagedWorktreePath[]; warnings: string[] } {
  if (input.mode === "none") {
    return { status: "not_requested", managedPaths: [], warnings: [] };
  }
  const target = join(input.projectsRoot, input.repoId, "node_modules");
  const link = join(input.worktreePath, "node_modules");
  if (existsSync(target) && existsSync(link)) {
    const stat = lstatSync(link);
    if (stat.isSymbolicLink() && realpathSync(link) === realpathSync(target)) {
      return {
        status: "ready",
        managedPaths: [{ path: "node_modules", target: realpathSync(target) }],
        warnings: [],
      };
    }
  }
  if (!existsSync(target) || existsSync(link)) {
    return {
      status: "failed",
      managedPaths: [],
      warnings: ["shared node_modules setup failed; the worktree was preserved"],
    };
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  return {
    status: "ready",
    managedPaths: [{ path: "node_modules", target: realpathSync(target) }],
    warnings: [],
  };
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}

function createResult(
  record: WorktreeRecord,
  reused: boolean,
  adopted: boolean,
  warnings: string[],
  recovered = false,
) {
  return {
    worktreeId: record.id,
    nodeId: record.nodeId,
    repoId: record.repoId,
    path: record.canonicalPath,
    branch: record.branch,
    createdFromSha: record.createdFromSha,
    head: record.createdFromSha,
    reused,
    recovered,
    adopted,
    setupStatus: record.setupStatus,
    warnings,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof WorktreeServiceError || error instanceof WorktreeGitError) return error.code;
  return "WORKTREE_REMOVE_FAILED";
}
