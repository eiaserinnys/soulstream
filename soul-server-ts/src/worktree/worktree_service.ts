// This file intentionally exceeds 500 lines: it owns the worktree lifecycle boundary where
// ownership records and repository lock transitions must stay coordinated. Shared setup checks
// live in worktree_setup.ts.
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { WorktreeExecutionResolver } from "../task/task_executor.js";
import { WorktreeGit, WorktreeGitError } from "./worktree_git.js";
import { RepositoryLock } from "./worktree_repository_lock.js";
import { defaultWorktreeSetupMode, setupSharedDependencies } from "./worktree_setup.js";
import type {
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
  setup?: WorktreeSetupMode;
  requireSetup?: boolean;
}

interface ResolvedCreateWorktreeInput extends CreateWorktreeInput {
  setup: WorktreeSetupMode;
  requireSetup: boolean;
}

export class WorktreeService implements WorktreeExecutionResolver {
  constructor(private readonly options: {
    nodeId: string;
    projectsRoot: string;
    git: WorktreeGit;
    createTimeoutMs: number;
    lock: RepositoryLock;
    host: WorktreeHost;
    listActiveWorkspaceDirs: () => string[];
  }) {}

  async list(input: {
    actorSessionId: string;
    repoId?: string;
    worktreeId?: string;
  }): Promise<Array<Record<string, unknown>>> {
    return await this.options.git.withOperationDeadline(
      async () => await this.listWithinDeadline(input),
    );
  }

  private async listWithinDeadline(input: {
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
        const dirty = discovered.kind === "external" || discovered.kind === "missing"
            ? null
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
              : discovered.kind === "missing"
                ? "managed_missing"
                : discovered.kind,
          dirty,
          dbState: record?.state ?? null,
          ownerKind: record ? (record.ownerFolderId ? "folder" : "session") : null,
          ownerId: record?.ownerFolderId ?? record?.createdBySessionId ?? null,
          mutableByCaller: record?.mutableByCaller ?? false,
          adoptionAllowed: discovered.kind === "unmanaged" && discovered.lockedReason === undefined,
          lockReason: discovered.lockedReason ?? null,
          activeSessionId: record?.activeSessionId ?? null,
          setupMode: record?.setupMode ?? null,
          setupRequired: record?.setupRequired ?? null,
          setupStatus: record?.setupStatus ?? null,
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
        ownerKind: record.ownerFolderId ? "folder" : "session",
        ownerId: record.ownerFolderId ?? record.createdBySessionId,
        mutableByCaller: record.mutableByCaller ?? false,
        adoptionAllowed: false,
        activeSessionId: record.activeSessionId ?? null,
        setupMode: record.setupMode,
        setupRequired: record.setupRequired,
        setupStatus: record.setupStatus,
        remoteStatus: "unknown",
        observedAt,
      });
    }
    return result;
  }

  async create(input: CreateWorktreeInput): Promise<Record<string, unknown>> {
    return await this.options.git.withOperationDeadline(
      async () => await this.createWithinDeadline(input),
      this.options.createTimeoutMs,
    );
  }

  private async createWithinDeadline(input: CreateWorktreeInput): Promise<Record<string, unknown>> {
    validateRepoId(input.repoId);
    const knownRecords = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      repoId: input.repoId,
    });
    const existing = knownRecords.find((record) =>
      record.branch === input.branch
      && record.state === "ready"
      && record.mutableByCaller === true);
    const repoPath = join(this.options.projectsRoot, input.repoId);
    const effectiveInput = resolveCreateInput(input, repoPath, existing);
    validateCreateInput(effectiveInput);
    if (existing) {
      await this.options.git.resolveManagedWorkspace({
        repoId: existing.repoId,
        path: existing.canonicalPath,
        worktreeId: existing.worktreeIdentity,
      });
      const commonDirectory = await this.options.git.commonDirectory(input.repoId);
      return await this.options.lock.withLock(commonDirectory, async () => {
        return await this.refreshExistingSetup(effectiveInput, existing);
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
      const lockedExisting = currentRecords.find((record) =>
        record.branch === input.branch
        && record.state === "ready"
        && record.mutableByCaller === true);
      if (lockedExisting) {
        await this.options.git.resolveManagedWorkspace({
          repoId: lockedExisting.repoId,
          path: lockedExisting.canonicalPath,
          worktreeId: lockedExisting.worktreeIdentity,
        });
        const lockedInput = resolveCreateInput(input, repoPath, lockedExisting);
        validateCreateInput(lockedInput);
        return await this.refreshExistingSetup(lockedInput, lockedExisting);
      }
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
        const setup = await setupSharedDependencies({
          projectsRoot: this.options.projectsRoot,
          repoId: effectiveInput.repoId,
          worktreePath: orphan.path,
          mode: effectiveInput.setup,
          operation: "create",
        }, this.options.git);
        const recovered = await this.options.host.register({
          actorSessionId: effectiveInput.actorSessionId,
          id: orphan.identity!,
          nodeId: this.options.nodeId,
          repoId: effectiveInput.repoId,
          canonicalPath: orphan.path,
          branch: effectiveInput.branch,
          createdFromSha: orphan.head,
          setupMode: effectiveInput.setup,
          setupRequired: effectiveInput.requireSetup,
          setupStatus: setup.status,
          managedPaths: setup.managedPaths,
          worktreeIdentity: orphan.identity!,
        });
        throwIfRequiredSetupFailed(recovered, setup.warnings);
        return createResult(recovered, true, input.mode === "adopt", setup.warnings, true);
      }
      const created = effectiveInput.mode === "adopt"
        ? await this.adopt(effectiveInput, worktreeId)
        : await this.options.git.create({
            actorSessionId: effectiveInput.actorSessionId,
            repoId: effectiveInput.repoId,
            branch: effectiveInput.branch,
            mode: effectiveInput.mode,
            worktreeId,
            ...(effectiveInput.startPoint ? { startPoint: effectiveInput.startPoint } : {}),
          });
      const setup = await setupSharedDependencies({
        projectsRoot: this.options.projectsRoot,
        repoId: effectiveInput.repoId,
        worktreePath: created.path,
        mode: effectiveInput.setup,
        operation: "create",
      }, this.options.git);
      const record = await this.options.host.register({
        actorSessionId: effectiveInput.actorSessionId,
        id: worktreeId,
        nodeId: this.options.nodeId,
        repoId: effectiveInput.repoId,
        canonicalPath: created.path,
        branch: effectiveInput.branch,
        createdFromSha: created.head,
        setupMode: effectiveInput.setup,
        setupRequired: effectiveInput.requireSetup,
        setupStatus: setup.status,
        managedPaths: setup.managedPaths,
        worktreeIdentity: worktreeId,
      });
      throwIfRequiredSetupFailed(record, setup.warnings);
      return createResult(record, false, effectiveInput.mode === "adopt", setup.warnings);
    });
  }

  private async refreshExistingSetup(
    input: ResolvedCreateWorktreeInput,
    existing: WorktreeRecord,
  ): Promise<Record<string, unknown>> {
    if (existing.setupMode === "none") return createResult(existing, true, false, []);
    const setup = await setupSharedDependencies({
      projectsRoot: this.options.projectsRoot,
      repoId: input.repoId,
      worktreePath: existing.canonicalPath,
      mode: existing.setupMode,
      operation: "reuse",
      previouslyManagedPaths: existing.managedPaths,
    }, this.options.git);
    const updated = await this.options.host.updateSetup({
      actorSessionId: input.actorSessionId,
      worktreeId: existing.id,
      setupStatus: setup.status,
      managedPaths: setup.managedPaths,
    });
    throwIfRequiredSetupFailed(updated, setup.warnings);
    return createResult(updated, true, false, setup.warnings);
  }

  async remove(input: { actorSessionId: string; worktreeId: string }): Promise<Record<string, unknown>> {
    return await this.options.git.withOperationDeadline(
      async () => await this.removeWithinDeadline(input),
    );
  }

  private async removeWithinDeadline(
    input: { actorSessionId: string; worktreeId: string },
  ): Promise<Record<string, unknown>> {
    const [initialRecord] = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      worktreeId: input.worktreeId,
    });
    if (!initialRecord || !initialRecord.mutableByCaller) {
      throw new WorktreeServiceError("WORKTREE_NOT_OWNED", input.worktreeId);
    }
    if (initialRecord.state === "removed") {
      return { worktreeId: initialRecord.id, removed: true, reused: true };
    }
    const commonDirectory = await this.options.git.commonDirectory(initialRecord.repoId);
    let record = initialRecord;
    try {
      await this.options.lock.withLock(commonDirectory, async () => {
        this.assertWorkspaceUnused(record.canonicalPath);
        const workspaceState = await this.options.git.removalWorkspaceState({
          repoId: record.repoId,
          path: record.canonicalPath,
          worktreeId: record.worktreeIdentity,
          branch: record.branch,
          expectedSha: record.branchDeleteExpectedSha,
        });
        if (workspaceState !== "registered") {
          const expectedSha = record.branchDeleteExpectedSha;
          if (!expectedSha) {
            throw new WorktreeServiceError(
              "WORKTREE_REMOVAL_HEAD_UNRECORDED",
              "The worktree registration disappeared before its branch HEAD was durably recorded",
            );
          }
          record = await this.options.host.beginRemove({
            ...input,
            expectedSha,
          });
          if (workspaceState === "registered_missing") {
            await this.options.git.pruneMissingWorktree({
              repoId: record.repoId,
              path: record.canonicalPath,
              worktreeId: record.worktreeIdentity,
            });
          } else {
            await this.options.git.finishPartialRemoval({
              repoId: record.repoId,
              path: record.canonicalPath,
              branch: record.branch,
              expectedSha,
            });
          }
          return;
        }
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
        const expectedSha = await this.options.git.removalHead({
          repoId: record.repoId,
          path: record.canonicalPath,
          worktreeId: record.worktreeIdentity,
          branch: record.branch,
        });
        record = await this.options.host.beginRemove({ ...input, expectedSha });
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
      if (error instanceof WorktreeGitError && error.code === "MANAGED_LINK_RESTORE_FAILED") {
        await this.options.host.updateSetup({
          ...input,
          setupStatus: "failed",
          managedPaths: record.managedPaths,
        });
      }
      throw error;
    }
    const removed = await this.options.host.finishRemove(input);
    return { worktreeId: removed.id, removed: true, branch: removed.branch };
  }

  async deleteBranch(input: { actorSessionId: string; worktreeId: string }) {
    return await this.options.git.withOperationDeadline(
      async () => await this.deleteBranchWithinDeadline(input),
    );
  }

  private async deleteBranchWithinDeadline(
    input: { actorSessionId: string; worktreeId: string },
  ) {
    const [initialRecord] = await this.options.host.list({
      actorSessionId: input.actorSessionId,
      nodeId: this.options.nodeId,
      worktreeId: input.worktreeId,
    });
    if (!initialRecord || !initialRecord.mutableByCaller) {
      throw new WorktreeServiceError("WORKTREE_NOT_OWNED", input.worktreeId);
    }
    if (initialRecord.state !== "removed") {
      throw new WorktreeServiceError("WORKTREE_NOT_REMOVED", input.worktreeId);
    }
    if (initialRecord.branchDeletedAt) return { worktreeId: initialRecord.id, deleted: true, reused: true };
    const commonDirectory = await this.options.git.commonDirectory(initialRecord.repoId);
    return await this.options.lock.withLock(commonDirectory, async () => {
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
      if (record.branchDeletedAt) {
        return { worktreeId: record.id, deleted: true, reused: true };
      }
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
    return await this.options.git.withOperationDeadline(async () => {
      const record = await this.options.host.resolveExecution({
        worktreeId,
        nodeId: this.options.nodeId,
      });
      return await this.options.git.resolveManagedWorkspace({
        repoId: record.repoId,
        path: record.canonicalPath,
        worktreeId: record.worktreeIdentity,
      });
    });
  }

  private async adopt(input: CreateWorktreeInput, worktreeId: string) {
    const path = realpathSync(input.adoptPath!);
    this.assertWorkspaceUnused(path);
    return await this.options.git.adopt({
      repoId: input.repoId,
      path,
      branch: input.branch,
      expectedHead: input.expectedHead!,
      worktreeId,
    });
  }

  private assertWorkspaceUnused(path: string): void {
    const projectsRoot = realpathSync(this.options.projectsRoot);
    for (const active of this.options.listActiveWorkspaceDirs()) {
      if (!existsSync(active)) continue;
      const activePath = realpathSync(active);
      if (containsPath(activePath, projectsRoot)) continue;
      if (overlaps(path, activePath)) {
        throw new WorktreeServiceError("WORKTREE_IN_USE", path);
      }
    }
  }
}

function resolveCreateInput(
  input: CreateWorktreeInput,
  repoPath: string,
  existing?: WorktreeRecord,
): ResolvedCreateWorktreeInput {
  if (existing) {
    if (
      (input.setup !== undefined && input.setup !== existing.setupMode)
      || (input.requireSetup !== undefined && input.requireSetup !== existing.setupRequired)
    ) {
      throw new WorktreeServiceError(
        "WORKTREE_SETUP_CONTRACT_MISMATCH",
        "Existing worktree setup contract differs from the request",
      );
    }
    return { ...input, setup: existing.setupMode, requireSetup: existing.setupRequired };
  }

  const setup = input.setup ?? (
    input.mode === "adopt" ? "none" : defaultWorktreeSetupMode(repoPath)
  );
  const requireSetup = input.requireSetup ?? (
    input.mode === "adopt" ? false : setup === "shared_dependencies"
  );
  return { ...input, setup, requireSetup };
}

function validateRepoId(repoId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(repoId)) {
    throw new WorktreeServiceError("INVALID_REPO_ID", `Invalid repo_id: ${repoId}`);
  }
}

function validateCreateInput(input: ResolvedCreateWorktreeInput): void {
  if (input.requireSetup && input.setup === "none") {
    throw new WorktreeServiceError(
      "INVALID_REQUEST",
      "require_setup=true requires a setup mode other than none",
    );
  }
  if (input.mode !== "new" && input.startPoint) {
    throw new WorktreeServiceError("INVALID_REQUEST", "start_point is new-mode only");
  }
  if (input.mode === "adopt" && (!input.adoptPath || !input.expectedHead)) {
    throw new WorktreeServiceError("INVALID_REQUEST", "adopt_path and expected_head are required");
  }
}

function throwIfRequiredSetupFailed(record: WorktreeRecord, warnings: string[]): void {
  if (!record.setupRequired || record.setupStatus !== "failed") return;
  throw new WorktreeServiceError(
    "WORKTREE_SETUP_REQUIRED",
    "Required shared test setup failed; the worktree and its registration were preserved",
    {
      worktreeId: record.id,
      path: record.canonicalPath,
      setupStatus: record.setupStatus,
      warnings,
    },
  );
}

function overlaps(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
    setupMode: record.setupMode,
    setupRequired: record.setupRequired,
    setupStatus: record.setupStatus,
    warnings,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof WorktreeServiceError || error instanceof WorktreeGitError) return error.code;
  return "WORKTREE_REMOVE_FAILED";
}
