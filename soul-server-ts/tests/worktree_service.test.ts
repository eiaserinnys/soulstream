import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  mkdirSync(join(repo, "packages", "ui"), { recursive: true });
  writeFileSync(join(repo, "packages", "ui", "package.json"), "{}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const host = new MemoryWorktreeHost();
  const service = new WorktreeService({
    nodeId: "node-a",
    projectsRoot,
    git: new WorktreeGit({ projectsRoot, timeoutMs: 5_000 }),
    createTimeoutMs: 5_000,
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
      details: { ignored: ["dist/"] },
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
    mkdirSync(join(unmanaged, "..scratch"));
    active.push(join(unmanaged, "..scratch"));

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

  it("allows adoption below projects root when only a generic workspace ancestor is active", async () => {
    const active: string[] = [];
    const { projectsRoot, repo, service } = fixture(active);
    active.push(dirname(projectsRoot));
    const unmanaged = join(projectsRoot, "demo--generic-workspace");
    git(repo, "worktree", "add", "-b", "feature/generic-workspace", unmanaged, "HEAD");

    await expect(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/generic-workspace",
      mode: "adopt",
      adoptPath: unmanaged,
      expectedHead: git(unmanaged, "rev-parse", "HEAD"),
      setup: "none",
      requireSetup: false,
    })).resolves.toMatchObject({ adopted: true });
  });

  it("lists locked initializing worktrees but never offers adoption", async () => {
    const { projectsRoot, repo, service } = fixture();
    const unmanaged = join(projectsRoot, "demo--locked-initializing");
    git(repo, "worktree", "add", "-b", "feature/locked-initializing", unmanaged, "HEAD");
    git(repo, "worktree", "lock", "--reason", "initializing", unmanaged);

    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: realpathSync(unmanaged),
          discoveryKind: "unmanaged_adoptable",
          adoptionAllowed: false,
          lockReason: "initializing",
        }),
      ]));
  });

  it("serializes concurrent create calls for the same branch", async () => {
    const { service, host } = fixture();
    const request = {
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/concurrent",
      mode: "new" as const,
      setup: "none" as const,
      requireSetup: false,
    };

    const [first, second] = await Promise.all([
      service.create(request),
      service.create(request),
    ]);

    expect(first.worktreeId).toBe(second.worktreeId);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(host.records.size).toBe(1);
  });

  it("rejects a required setup contract that requests no setup", async () => {
    const { service } = fixture();

    await expect(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/invalid-setup",
      mode: "new",
      setup: "none",
      requireSetup: true,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("reports actual dirty state for the base checkout", async () => {
    const { repo, service } = fixture();
    writeFileSync(join(repo, "README.md"), "changed\n");

    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          discoveryKind: "base",
          dirty: expect.objectContaining({ clean: false, tracked: ["README.md"] }),
        }),
      ]));
  });

  it("rejects adoption when the requested branch differs from the discovered branch", async () => {
    const { projectsRoot, repo, service } = fixture();
    const unmanaged = join(projectsRoot, "demo--branch-mismatch");
    git(repo, "worktree", "add", "-b", "feature/actual", unmanaged, "HEAD");

    await expect(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/requested",
      mode: "adopt",
      adoptPath: unmanaged,
      expectedHead: git(unmanaged, "rev-parse", "HEAD"),
      setup: "none",
      requireSetup: false,
    })).rejects.toMatchObject({ code: "WORKTREE_BRANCH_MISMATCH" });
  });

  it("retries a required shared-dependency setup without deleting real node_modules", async () => {
    const { repo, service, host } = fixture();
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
    mkdirSync(join(repo, "packages", "ui", "node_modules"));
    writeFileSync(join(repo, "packages", "ui", "node_modules", "ui-only.txt"), "preserve");
    const retried = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-retry",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });
    expect(retried.warnings).toEqual([]);
    expect(retried).toMatchObject({ reused: true, setupStatus: "ready" });
    expect(host.records.get(String(created.worktreeId))?.managedPaths.map(({ path }) => path))
      .toEqual(["node_modules", "packages/ui/node_modules"]);

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(existsSync(join(repo, "node_modules", "base-only.txt"))).toBe(true);
    expect(existsSync(join(repo, "packages", "ui", "node_modules", "ui-only.txt"))).toBe(true);
  });

  it("refuses removal while an attached or retained runner still owns the cwd", async () => {
    const active: string[] = [];
    const { service, host } = fixture(active);
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/retained-runner",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    active.push(String(created.path));

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
  });

  it("reaches dirty classification when only a generic workspace ancestor is active", async () => {
    const active: string[] = [];
    const { projectsRoot, service, host } = fixture(active);
    active.push(dirname(projectsRoot));
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/generic-workspace-dirty",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    writeFileSync(join(String(created.path), "README.md"), "dirty\n");

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
      details: { tracked: ["README.md"] },
    });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
  });

  it("prunes an identity-verified stale registration when the path is already missing", async () => {
    const { repo, service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/missing-path",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    rmSync(String(created.path), { recursive: true, force: true });
    const record = host.records.get(String(created.worktreeId))!;
    host.records.set(record.id, {
      ...record,
      branchDeleteExpectedSha: String(created.head),
    });

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(String(created.path));
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
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

  it("lists an out-of-root Git worktree as external without trying to mutate or inspect it", async () => {
    const { repo, service } = fixture();
    const externalRoot = mkdtempSync(join(tmpdir(), "worktree-service-external-"));
    roots.push(externalRoot);
    const external = join(externalRoot, "external");
    git(repo, "worktree", "add", "-b", "feature/external-service", external, "HEAD");

    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: external,
          discoveryKind: "unmanaged_external",
          dirty: null,
          adoptionAllowed: false,
        }),
      ]));
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
    const current = this.records.get(input.worktreeId);
    if (
      current?.branchDeleteExpectedSha
      && current.branchDeleteExpectedSha !== input.expectedSha
    ) throw new Error("WORKTREE_REMOVAL_HEAD_CHANGED");
    return this.update(input.worktreeId, {
      state: "removing",
      branchDeleteExpectedSha: current?.branchDeleteExpectedSha ?? input.expectedSha,
    });
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
