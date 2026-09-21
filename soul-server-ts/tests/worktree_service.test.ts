import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorktreeGit } from "../src/worktree/worktree_git.js";
import { RepositoryLock } from "../src/worktree/worktree_repository_lock.js";
import { WorktreeService } from "../src/worktree/worktree_service.js";
import type { WorktreeHost, WorktreeRecord } from "../src/worktree/worktree_types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(active: string[] = []) {
  const projectsRoot = mkdtempSync(join(tmpdir(), "worktree-service-"));
  roots.push(projectsRoot);
  const repo = join(projectsRoot, "demo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const host = new MemoryWorktreeHost();
  const service = new WorktreeService({
    nodeId: "node-a",
    projectsRoot,
    git: new WorktreeGit({ projectsRoot, timeoutMs: 5_000 }),
    lock: new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 2_000 }),
    host,
    listActiveWorkspaceDirs: () => active,
  });
  return { projectsRoot, repo, host, service };
}

describe("WorktreeService", () => {
  it("creates, reuses, lists and removes only a clean owned worktree", async () => {
    const { service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/service",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    expect(created).toMatchObject({ reused: false, setupStatus: "not_requested" });
    const repeated = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/service",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    expect(repeated).toMatchObject({
      worktreeId: created.worktreeId,
      reused: true,
    });
    const listed = await service.list({ actorSessionId: "owner", repoId: "demo" });
    expect(listed.map((entry) => entry.discoveryKind))
      .toEqual(expect.arrayContaining(["base", "managed"]));

    const path = String(created.path);
    mkdirSync(join(path, "dist"));
    writeFileSync(join(path, "dist", "bundle.js"), "generated");
    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
      details: { ignored: ["dist/bundle.js"] },
    });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");

    rmSync(join(path, "dist"), { recursive: true });
    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          worktreeId: created.worktreeId,
          discoveryKind: "managed_missing",
          dbState: "removed",
        }),
      ]));
  });

  it("refuses adoption when an active task cwd overlaps the candidate", async () => {
    const active: string[] = [];
    const { projectsRoot, repo, service } = fixture(active);
    const unmanaged = join(projectsRoot, "demo--unmanaged");
    git(repo, "worktree", "add", "-b", "feature/unmanaged", unmanaged, "HEAD");
    mkdirSync(join(unmanaged, "child"));
    active.push(join(unmanaged, "child"));

    await expect(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/unmanaged",
      mode: "adopt",
      adoptPath: unmanaged,
      expectedHead: git(unmanaged, "rev-parse", "HEAD"),
      setup: "none",
      requireSetup: false,
    })).rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
  });

  it("retries a required shared-dependency setup without deleting real node_modules", async () => {
    const { repo, service } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-retry",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });
    expect(created).toMatchObject({ setupStatus: "failed" });

    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "base-only.txt"), "preserve");
    const retried = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-retry",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });
    expect(retried).toMatchObject({ reused: true, setupStatus: "ready" });

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(existsSync(join(repo, "node_modules", "base-only.txt"))).toBe(true);
  });

  it("recovers an identified worktree when Git succeeded before DB registration failed", async () => {
    const { service, host } = fixture();
    host.registerFailuresRemaining = 1;
    const request = {
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/register-recovery",
      mode: "new" as const,
      setup: "none" as const,
      requireSetup: false,
    };

    await expect(service.create(request)).rejects.toThrow("simulated DB failure");
    const recovered = await service.create(request);

    expect(recovered).toMatchObject({ reused: true, recovered: true });
    expect(host.records.size).toBe(1);
    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          worktreeId: recovered.worktreeId,
          discoveryKind: "managed",
        }),
      ]));
  });

  it("finishes a removing record on retry when Git removal succeeded before DB transition failed", async () => {
    const { service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/remove-recovery",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    host.finishRemoveFailuresRemaining = 1;

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toThrow("simulated finish failure");
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removing");
    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
  });
});

class MemoryWorktreeHost implements WorktreeHost {
  readonly records = new Map<string, WorktreeRecord>();
  registerFailuresRemaining = 0;
  finishRemoveFailuresRemaining = 0;

  async list(input: Parameters<WorktreeHost["list"]>[0]) {
    return [...this.records.values()]
      .filter((record) => record.nodeId === input.nodeId)
      .filter((record) => !input.repoId || record.repoId === input.repoId)
      .filter((record) => !input.worktreeId || record.id === input.worktreeId)
      .map((record) => ({
        ...record,
        mutableByCaller: record.createdBySessionId === input.actorSessionId,
        activeSessionId: null,
      }));
  }

  async register(input: Parameters<WorktreeHost["register"]>[0]) {
    if (this.registerFailuresRemaining > 0) {
      this.registerFailuresRemaining -= 1;
      throw new Error("simulated DB failure");
    }
    const record: WorktreeRecord = {
      id: input.id,
      nodeId: input.nodeId,
      repoId: input.repoId,
      canonicalPath: input.canonicalPath,
      branch: input.branch,
      createdFromSha: input.createdFromSha,
      ownerTaskId: null,
      createdBySessionId: input.actorSessionId,
      state: "ready",
      setupMode: input.setupMode,
      setupRequired: input.setupRequired,
      setupStatus: input.setupStatus,
      managedPaths: input.managedPaths,
      worktreeIdentity: input.worktreeIdentity,
      branchDeleteExpectedSha: null,
      branchDeleteMarkerRef: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  async updateSetup(input: Parameters<WorktreeHost["updateSetup"]>[0]) {
    return this.update(input.worktreeId, {
      setupStatus: input.setupStatus,
      managedPaths: input.managedPaths,
    });
  }

  async beginRemove(input: Parameters<WorktreeHost["beginRemove"]>[0]) {
    return this.update(input.worktreeId, { state: "removing" });
  }
  async restoreReady(input: Parameters<WorktreeHost["restoreReady"]>[0]) {
    return this.update(input.worktreeId, {
      state: "ready",
      lastErrorCode: input.errorCode,
      lastErrorMessage: input.errorMessage,
    });
  }
  async finishRemove(input: Parameters<WorktreeHost["finishRemove"]>[0]) {
    if (this.finishRemoveFailuresRemaining > 0) {
      this.finishRemoveFailuresRemaining -= 1;
      throw new Error("simulated finish failure");
    }
    return this.update(input.worktreeId, { state: "removed" });
  }
  async beginBranchDelete(input: Parameters<WorktreeHost["beginBranchDelete"]>[0]) {
    return this.update(input.worktreeId, {
      branchDeleteExpectedSha: input.expectedSha,
      branchDeleteMarkerRef: input.markerRef,
    });
  }
  async finishBranchDelete(input: Parameters<WorktreeHost["finishBranchDelete"]>[0]) {
    return this.update(input.worktreeId, { branchDeletedAt: new Date().toISOString() });
  }
  async resolveExecution(input: Parameters<WorktreeHost["resolveExecution"]>[0]) {
    const record = this.records.get(input.worktreeId);
    if (!record || record.nodeId !== input.nodeId || record.state !== "ready") throw new Error("unavailable");
    return record;
  }

  private update(id: string, patch: Partial<WorktreeRecord>): WorktreeRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("missing record");
    const updated = { ...record, ...patch };
    this.records.set(id, updated);
    return updated;
  }
}
