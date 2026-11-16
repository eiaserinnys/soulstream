import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreeGit } from "../src/worktree/worktree_git.js";
import { RepositoryLock } from "../src/worktree/worktree_repository_lock.js";
import { WorktreeService } from "../src/worktree/worktree_service.js";
import type { WorktreeHost, WorktreeRecord } from "../src/worktree/worktree_types.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const projectsRoot = mkdtempSync(join(tmpdir(), "worktree-list-page-"));
  roots.push(projectsRoot);
  const repo = join(projectsRoot, "demo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const host = new MemoryWorktreeHost();
  const worktreeGit = new WorktreeGit({ projectsRoot, timeoutMs: 20_000 });
  const service = new WorktreeService({
    nodeId: "node-a",
    projectsRoot,
    git: worktreeGit,
    createTimeoutMs: 20_000,
    lock: new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 5_000 }),
    host,
    listActiveWorkspaceDirs: () => [],
  });
  return { projectsRoot, repo, host, service, worktreeGit };
}

class MemoryWorktreeHost implements WorktreeHost {
  readonly records = new Map<string, WorktreeRecord>();

  async sweepCandidates() {
    return [];
  }

  async list(input: Parameters<WorktreeHost["list"]>[0]) {
    return [...this.records.values()]
      .filter((record) => record.nodeId === input.nodeId)
      .filter((record) => !input.repoId || record.repoId === input.repoId)
      .filter((record) => !input.worktreeId || record.id === input.worktreeId)
      .map((record) => ({
        ...record,
        mutableByCaller: record.createdBySessionId === input.actorSessionId,
        removableByCaller: record.createdBySessionId === input.actorSessionId,
        activeSessionId: null,
      }));
  }

  async register(input: Parameters<WorktreeHost["register"]>[0]) {
    const record: WorktreeRecord = {
      id: input.id,
      nodeId: input.nodeId,
      repoId: input.repoId,
      canonicalPath: input.canonicalPath,
      branch: input.branch,
      createdFromSha: input.createdFromSha,
      ownerFolderId: null,
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

  async updateSetup(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async beginRemove(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async restoreReady(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async finishRemove(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async beginBranchDelete(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async finishBranchDelete(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
  async resolveExecution(): Promise<WorktreeRecord> {
    throw new Error("unused");
  }
}

async function pagedFixture() {
  const setup = fixture();
  for (let index = 0; index < 21; index += 1) {
    await setup.service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: `feature/page-${index}`,
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
  }
  for (let index = 0; index < 30; index += 1) {
    const id = `removed-${index}`;
    setup.host.records.set(id, {
      id,
      nodeId: "node-a",
      repoId: "demo",
      canonicalPath: join(setup.projectsRoot, `demo--removed-${index}`),
      branch: `feature/removed-${index}`,
      createdFromSha: "0".repeat(40),
      ownerFolderId: null,
      createdBySessionId: "owner",
      state: "removed",
      setupMode: "none",
      setupRequired: false,
      setupStatus: "not_requested",
      managedPaths: [],
      worktreeIdentity: id,
      branchDeleteExpectedSha: null,
      branchDeleteMarkerRef: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  }
  return setup;
}

describe("WorktreeService.list paging and removed filtering", () => {
  it("pages the default list without removed records and inspects dirty only for the page", async () => {
    const { service, worktreeGit } = await pagedFixture();
    const inspectDirty = vi.spyOn(worktreeGit, "inspectDirty");

    const first = await service.list({ actorSessionId: "owner", repoId: "demo" });

    expect(first.total).toBe(22);
    expect(first.worktrees).toHaveLength(20);
    expect(first.worktrees.every((entry) => entry.dbState !== "removed")).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(inspectDirty).toHaveBeenCalledTimes(20);

    const second = await service.list({
      actorSessionId: "owner",
      repoId: "demo",
      cursor: first.nextCursor!,
    });

    expect(second.total).toBe(22);
    expect(second.worktrees).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(inspectDirty).toHaveBeenCalledTimes(22);
    const keys = [...first.worktrees, ...second.worktrees]
      .map((entry) => entry.worktreeId ?? entry.path);
    expect(new Set(keys).size).toBe(22);
  });

  it("returns a removed record by full worktree_id and includes removed records on request", async () => {
    const { service } = await pagedFixture();

    const byId = await service.list({
      actorSessionId: "owner",
      repoId: "demo",
      worktreeId: "removed-7",
    });
    expect(byId.worktrees).toEqual([
      expect.objectContaining({
        worktreeId: "removed-7",
        discoveryKind: "managed_missing",
        dbState: "removed",
      }),
    ]);
    expect(byId.total).toBe(1);

    const withRemoved = await service.list({
      actorSessionId: "owner",
      repoId: "demo",
      includeRemoved: true,
      limit: 50,
    });
    expect(withRemoved.total).toBe(52);
    expect(withRemoved.worktrees).toHaveLength(50);
    expect(withRemoved.nextCursor).toEqual(expect.any(String));

    const tail = await service.list({
      actorSessionId: "owner",
      repoId: "demo",
      includeRemoved: true,
      limit: 50,
      cursor: withRemoved.nextCursor!,
    });
    expect(tail.worktrees).toHaveLength(2);
    expect(tail.nextCursor).toBeNull();
    expect(tail.worktrees.every((entry) => entry.dbState === "removed")).toBe(true);
  });

  it("rejects a cursor from a different query and a malformed cursor", async () => {
    const { service } = await pagedFixture();
    const first = await service.list({ actorSessionId: "owner", repoId: "demo" });

    await expect(service.list({
      actorSessionId: "owner",
      repoId: "demo",
      includeRemoved: true,
      cursor: first.nextCursor!,
    })).rejects.toMatchObject({ code: "WORKTREE_CURSOR_INVALID" });

    await expect(service.list({
      actorSessionId: "owner",
      repoId: "demo",
      cursor: "not-a-cursor",
    })).rejects.toMatchObject({ code: "WORKTREE_CURSOR_INVALID" });
  });
});
