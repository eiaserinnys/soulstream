import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dependencyLinks from "../src/worktree/worktree_dependency_links.js";
import { GitProcessError } from "../src/worktree/worktree_process.js";
import { WorktreeGit } from "../src/worktree/worktree_git.js";
import { RepositoryLock } from "../src/worktree/worktree_repository_lock.js";
import { WorktreeService, WorktreeServiceError } from "../src/worktree/worktree_service.js";
import type { WorktreeHost, WorktreeRecord } from "../src/worktree/worktree_types.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
  const worktreeGit = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
  const service = new WorktreeService({
    nodeId: "node-a",
    projectsRoot,
    git: worktreeGit,
    createTimeoutMs: 5_000,
    lock: new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 2_000 }),
    host,
    listActiveWorkspaceDirs: () => active,
  });
  return { projectsRoot, repo, host, service, worktreeGit };
}

async function submoduleFixture() {
  const setup = fixture();
  const origin = join(setup.projectsRoot, "theme-source");
  mkdirSync(origin);
  git(origin, "init", "-b", "main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test");
  writeFileSync(join(origin, "theme.txt"), "original theme\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "theme");
  git(setup.repo, "-c", "protocol.file.allow=always", "submodule", "add", origin, "themes/PaperMod");
  git(setup.repo, "commit", "-am", "add submodule");
  const created = await setup.service.create({ actorSessionId: "owner", repoId: "demo", branch: "submodule-test", mode: "new" });
  const path = String(created.path);
  git(path, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
  expect(git(path, "status", "--porcelain")).toBe("");
  return { ...setup, created, path, submodule: join(path, "themes", "PaperMod") };
}

function configurePnpmRepo(
  repo: string,
  uiManifest: Record<string, unknown> = { name: "ui", devDependencies: { vitest: "*" } },
) {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ packageManager: "pnpm@10.32.1" }));
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(repo, "packages", "ui", "package.json"), JSON.stringify(uiManifest));
}

function commitFixtureChanges(repo: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "configure worktree setup fixture");
}

function addRunner(repo: string, packagePath: string, runner: "vitest" | "jest" = "vitest") {
  const executable = join(repo, packagePath, "node_modules", ".bin", runner);
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  return executable;
}

async function captureWorktreeError(operation: Promise<unknown>): Promise<WorktreeServiceError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof WorktreeServiceError) return error;
    throw error;
  }
  throw new Error("Expected worktree operation to fail");
}

describe("WorktreeService", () => {
  it.each(["modified", "untracked"])("rejects %s submodule contents through the existing dirty gate", async (kind) => {
    const { service, worktreeGit, created, path, submodule } = await submoduleFixture();
    const userFile = join(submodule, kind === "modified" ? "theme.txt" : "user.txt");
    writeFileSync(userFile, "preserve user work");
    expect(git(path, "status", "--porcelain")).toContain("themes/PaperMod");
    expect(await worktreeGit.inspectDirty(path, [])).toMatchObject({ tracked: ["themes/PaperMod"] });
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .rejects.toMatchObject({ code: "WORKTREE_DIRTY", details: { tracked: ["themes/PaperMod"] } });
    expect(readFileSync(userFile, "utf8")).toBe("preserve user work");
  });

  it("removes a clean worktree with an initialized submodule", async () => {
    const { service, created, path, submodule } = await submoduleFixture();
    expect(readFileSync(join(submodule, "theme.txt"), "utf8")).toBe("original theme\n");
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .resolves.toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
  });

  it("resumes after interrupted ignored cleanup without deleting tracked files", async () => {
    const { service, worktreeGit, host } = fixture();
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: "interrupted-ignored", mode: "new" });
    const path = String(created.path), id = String(created.worktreeId);
    for (const name of ["first", "remaining"]) {
      mkdirSync(join(path, "node_modules", name), { recursive: true });
      writeFileSync(join(path, "node_modules", name, "cache"), Buffer.alloc(4 * 1024 * 1024));
    }
    const gitRemove = vi.spyOn(worktreeGit, "remove");
    vi.spyOn(worktreeGit, "removeIgnored").mockImplementationOnce(async () => {
      expect(host.records.get(id)?.state).toBe("removing");
      rmSync(join(path, "node_modules", "first"), { recursive: true });
      throw new GitProcessError("PROCESS_TIMEOUT", "simulated ignored cleanup interruption", true);
    });
    await expect(service.remove({ actorSessionId: "owner", worktreeId: id })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
    expect(gitRemove).not.toHaveBeenCalled();
    expect(host.records.get(id)?.state).toBe("ready");
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("base\n");
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(path, "node_modules", "remaining", "cache"))).toBe(true);
    await expect(service.remove({ actorSessionId: "owner", worktreeId: id })).resolves.toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
  });

  it("removes ignored symlinks without touching their external targets", async () => {
    const { service, projectsRoot } = fixture();
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: "external-ignored", mode: "new" });
    const path = String(created.path), external = join(projectsRoot, "external-data");
    mkdirSync(external); writeFileSync(join(external, "user.txt"), "preserve");
    mkdirSync(join(path, "node_modules"));
    symlinkSync(external, join(path, "node_modules", "external"), "dir");
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .resolves.toMatchObject({ removed: true });
    expect(readFileSync(join(external, "user.txt"), "utf8")).toBe("preserve");
  });

  it.each([false, true])("sweeps missing directories and branches despite a recorded SHA (registered=%s)", async (registered) => {
    const { service, repo, host } = fixture();
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: "ghost", mode: "new" });
    const path = String(created.path), id = String(created.worktreeId);
    if (registered) rmSync(path, { recursive: true });
    else git(repo, "worktree", "remove", path);
    git(repo, "update-ref", "-d", "refs/heads/ghost");
    host.records.set(id, { ...host.records.get(id)!, branchDeleteExpectedSha: String(created.head),
      lastSessionActivityAt: new Date().toISOString(), linkedCardsClosed: false });
    const result = await service.sweep({ now: Date.now() + 4 * 60 * 60_000 });
    expect(result).toMatchObject({ removed: 1, failed: 0 });
    expect(host.records.get(id)?.state).toBe("removed");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(path);
  });

  it.each(["tracked", "untracked"])("preserves %s changes even alongside ignored dependencies", async (kind) => {
    const { service } = fixture();
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: `dirty/${kind}`, mode: "new" });
    const path = String(created.path);
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "generated"), "ignored");
    writeFileSync(join(path, kind === "tracked" ? "README.md" : "work.txt"), "preserve");
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .rejects.toMatchObject({ code: "WORKTREE_DIRTY", details: { ignored: ["node_modules/"] } });
    expect(existsSync(path)).toBe(true);
  });

  it("gives Git removal the configured creation deadline", async () => {
    const { projectsRoot, repo, service, host } = fixture();
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: "remove-timeout", mode: "new" });
    const { runBoundedProcess } = await import("../src/worktree/worktree_process.js");
    let removalTimeout: number | undefined;
    const boundedGit = new WorktreeGit({ projectsRoot, timeoutMs: 5_000, createTimeoutMs: 45_000,
      processRunner: async (input) => {
        if (input.args[0] === "worktree" && input.args[1] === "remove") removalTimeout = input.timeoutMs;
        return await runBoundedProcess(input);
      },
    });
    const deadline = vi.spyOn(boundedGit, "withOperationDeadline");
    const remover = new WorktreeService({ nodeId: "node-a", projectsRoot, git: boundedGit, createTimeoutMs: 45_000,
      host, lock: new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 2_000 }), listActiveWorkspaceDirs: () => [] });
    await remover.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) });
    expect(removalTimeout).toBe(45_000);
    expect(deadline).toHaveBeenCalledWith(expect.any(Function), 45_000);
    expect(git(repo, "rev-parse", "refs/heads/remove-timeout")).toBe(created.head);
  });

  it.each([false, true])("keeps an unchanged initial HEAD unless its card is closed (%s)", async (closed) => {
    const { projectsRoot, repo, service, host } = fixture();
    const origin = join(projectsRoot, "remote.git");
    git(projectsRoot, "init", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
    const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: "waiting", mode: "new" });
    const id = String(created.worktreeId);
    const now = Date.now() + 4 * 60 * 60_000;
    host.records.set(id, { ...host.records.get(id)!,
      lastSessionActivityAt: new Date(now - 4 * 60 * 60_000).toISOString(), linkedCardsClosed: closed });
    expect(git(String(created.path), "rev-parse", "HEAD")).toBe(host.records.get(id)!.createdFromSha);
    const result = await service.sweep({ now });
    expect(result).toMatchObject({ removed: closed ? 1 : 0, not_finished: closed ? 0 : 1 });
    expect(existsSync(String(created.path))).toBe(!closed);
  });

  it("sweeps only finished clean pushed worktrees, once per repo, preserving branches", async () => {
    const active: string[] = [];
    const { projectsRoot, repo, service, host } = fixture(active);
    const origin = join(projectsRoot, "remote.git");
    git(projectsRoot, "init", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");
    const now = Date.now() + 10 * 24 * 60 * 60_000;
    const old = new Date(now - 4 * 60 * 60_000).toISOString();
    const paths = new Map<string, string>();
    const ids = new Map<string, string>();
    for (const kind of ["merged", "closed", "idle", "recent", "git_recent", "active", "links", "tracked", "untracked", "unpushed", "unfinished", "raced", "failed", "missing", "prunable", "no_branch"]) {
      const created = await service.create({ actorSessionId: "owner", repoId: "demo", branch: `sweep/${kind}`, mode: "new" });
      const path = String(created.path), id = String(created.worktreeId);
      paths.set(kind, path); ids.set(kind, id);
      if (!["missing", "prunable", "no_branch"].includes(kind)) {
        writeFileSync(join(path, "feature.txt"), kind);
        git(path, "add", "."); git(path, "commit", "-m", kind);
        if (kind !== "unpushed") git(path, "push", "origin", `sweep/${kind}`);
        if (kind === "merged") {
          git(repo, "merge", "--ff-only", `sweep/${kind}`);
          git(repo, "push", "origin", "main");
        }
      }
      const record = host.records.get(id)!;
      host.records.set(id, { ...record, lastSessionActivityAt: kind === "recent" ? new Date(now).toISOString() : kind === "idle" ? new Date(now - 8 * 24 * 60 * 60_000).toISOString() : old,
        linkedCardsClosed: ["closed", "active", "links", "tracked", "untracked", "unpushed", "raced", "failed", "git_recent"].includes(kind) });
      if (kind === "git_recent") {
        const dir = git(path, "rev-parse", "--absolute-git-dir");
        for (const file of ["HEAD", "index", "logs/HEAD"]) utimesSync(join(dir, file), now / 1000, now / 1000);
      }
      if (kind === "active") active.push(path);
      if (kind === "links") { mkdirSync(join(repo, "node_modules")); symlinkSync(join(path, "packages", "ui"), join(repo, "node_modules", "ui"), "dir"); }
      if (kind === "tracked") writeFileSync(join(path, "README.md"), "user edit");
      if (kind === "untracked") writeFileSync(join(path, "user.txt"), "user data");
      if (kind === "missing" || kind === "no_branch") git(repo, "worktree", "remove", path);
      if (kind === "no_branch") git(repo, "branch", "-d", `sweep/${kind}`);
      if (kind === "prunable") rmSync(path, { recursive: true });
      if (kind === "merged") { mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "ignored"); }
    }
    const originalBegin = host.beginRemove.bind(host);
    const begin = vi.spyOn(host, "beginRemove").mockImplementation(async (input) => {
      if (input.worktreeId === ids.get("raced")) throw Object.assign(new Error("WORKTREE_IN_USE: late-session"), { code: "WORKTREE_IN_USE" });
      if (input.worktreeId === ids.get("failed")) throw new Error("simulated failure");
      return originalBegin(input);
    });
    const { runBoundedProcess } = await import("../src/worktree/worktree_process.js");
    let fetches = 0;
    const sweepGit = new WorktreeGit({ projectsRoot, timeoutMs: 5_000, createTimeoutMs: 5_000,
      processRunner: async (input) => { if (input.args[0] === "fetch") fetches++; return runBoundedProcess(input); } });
    const lock = new RepositoryLock({ lockRoot: join(projectsRoot, ".locks"), defaultTimeoutMs: 2_000 });
    const originalWithLock = lock.withLock.bind(lock);
    let lockHeld = false;
    vi.spyOn(lock, "withLock").mockImplementation(async (key, action) => originalWithLock(key, async () => {
      lockHeld = true;
      try { return await action(); } finally { lockHeld = false; }
    }));
    const originalCollect = dependencyLinks.collectBaseDependencyLinks;
    const collect = vi.spyOn(dependencyLinks, "collectBaseDependencyLinks").mockImplementation(async (base) => {
      expect(lockHeld).toBe(false);
      return await originalCollect(base);
    });
    const sweeper = new WorktreeService({ nodeId: "node-a", projectsRoot, git: sweepGit, createTimeoutMs: 5_000, host,
      lock, listActiveWorkspaceDirs: () => active });
    const result = await sweeper.sweep({ now });
    expect(result).toMatchObject({ candidates: 16, removed: 6, recent: 2, in_use: 2, base_links: 1, changes: 2, unpushed: 1, not_finished: 1, failed: 1 });
    expect(fetches).toBe(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledWith(repo);
    for (const kind of ["merged", "closed", "idle", "missing", "prunable", "no_branch"]) {
      expect(existsSync(paths.get(kind)!)).toBe(false);
      expect(host.records.get(ids.get(kind)!)?.state).toBe("removed");
      if (kind !== "no_branch") expect(git(repo, "rev-parse", `refs/heads/sweep/${kind}`)).toBeTruthy();
    }
    for (const kind of ["recent", "git_recent", "active", "links", "tracked", "untracked", "unpushed", "unfinished", "raced", "failed"]) {
      expect(existsSync(paths.get(kind)!)).toBe(true);
      expect(host.records.get(ids.get(kind)!)?.state).toBe("ready");
    }
    expect(begin.mock.calls.every(([input]) => input.sweeperNodeId === "node-a" && !input.actorSessionId)).toBe(true);
  });

  it("preserves a shared worktree when base dependency links point back into it", async () => {
    const { repo, service, host } = fixture();
    mkdirSync(join(repo, "node_modules"));
    mkdirSync(join(repo, "packages", "ui", "node_modules"));
    const created = await service.create({
      actorSessionId: "owner", repoId: "demo", branch: "feature/base-links",
      mode: "new", setup: "shared_dependencies", requireSetup: false,
    });
    const path = String(created.path);
    const target = join(path, "packages", "ui");
    const rootLink = join(repo, "node_modules", "ui");
    const packageLink = join(repo, "packages", "ui", "node_modules", "@demo", "ui");
    mkdirSync(dirname(packageLink));
    symlinkSync(target, rootLink, "dir");
    symlinkSync(relative(dirname(packageLink), target), packageLink, "dir");
    const beginRemove = vi.spyOn(host, "beginRemove");

    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .rejects.toMatchObject({
        code: "WORKTREE_BASE_DEPENDENCY_IN_USE",
        details: { links: [
          { path: "node_modules/ui", target },
          { path: "packages/ui/node_modules/@demo/ui", target },
        ] },
      });
    expect(beginRemove).not.toHaveBeenCalled();
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
    expect(realpathSync(join(path, "node_modules"))).toBe(realpathSync(join(repo, "node_modules")));
    expect(realpathSync(rootLink)).toBe(target);
    expect(realpathSync(packageLink)).toBe(target);

    rmSync(rootLink);
    rmSync(packageLink);
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .resolves.toMatchObject({ removed: true });
  });

  it("blocks a base node_modules directory linked into an independently set up worktree", async () => {
    const { repo, service } = fixture();
    const created = await service.create({
      actorSessionId: "owner", repoId: "demo", branch: "feature/base-directory",
      mode: "new", setup: "none",
    });
    const target = join(String(created.path), "packages", "ui");
    symlinkSync(target, join(repo, "node_modules"), "dir");
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .rejects.toMatchObject({
        code: "WORKTREE_BASE_DEPENDENCY_IN_USE",
        details: { links: [{ path: "node_modules", target }] },
      });
    expect(existsSync(String(created.path))).toBe(true);
  });

  it("allows base dependency links to a different worktree with a matching path prefix", async () => {
    const { repo, service } = fixture();
    const created = await service.create({
      actorSessionId: "owner", repoId: "demo", branch: "feature/sibling-link",
      mode: "new", setup: "none",
    });
    const sibling = `${String(created.path)}-other`;
    mkdirSync(sibling);
    mkdirSync(join(repo, "node_modules"));
    symlinkSync(sibling, join(repo, "node_modules", "other"), "dir");
    await expect(service.remove({ actorSessionId: "owner", worktreeId: String(created.worktreeId) }))
      .resolves.toMatchObject({ removed: true });
    expect(realpathSync(join(repo, "node_modules", "other"))).toBe(sibling);
  });

  it("rejects invalid repository IDs before reading setup defaults", async () => {
    const { service, host } = fixture();
    const list = vi.spyOn(host, "list");

    const failure = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "../outside",
      branch: "feature/invalid-repo-id",
      mode: "new",
    }));

    expect(failure.code).toBe("INVALID_REPO_ID");
    expect(list).not.toHaveBeenCalled();
  });

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
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "generated.js"), "dependency");
    await expect(service.remove({
      actorSessionId: "owner", worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
    await expect(service.list({ actorSessionId: "owner", repoId: "demo" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          worktreeId: created.worktreeId,
          discoveryKind: "managed_missing",
          dbState: "removed",
          setupMode: "none",
          setupRequired: false,
          setupStatus: "not_requested",
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

  it("defaults new pnpm worktrees to required shared setup and preserves failure details", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    rmSync(join(repo, "pnpm-workspace.yaml"));
    commitFixtureChanges(repo);
    const failure = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-required",
      mode: "new",
    }));
    expect(failure.code).toBe("WORKTREE_SETUP_REQUIRED");
    expect(failure.details).toMatchObject({
      setupStatus: "failed",
      warnings: expect.arrayContaining([expect.stringContaining("packages/ui")]),
    });
    const details = failure.details!;
    const record = host.records.get(String(details.worktreeId));
    expect(record).toMatchObject({
      canonicalPath: details.path,
      setupMode: "shared_dependencies",
      setupRequired: true,
      setupStatus: "failed",
    });
    expect(existsSync(String(details.path))).toBe(true);

    const explicitShared = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-explicit-shared-required",
      mode: "new",
      setup: "shared_dependencies",
    }));
    expect(explicitShared.code).toBe("WORKTREE_SETUP_REQUIRED");
    expect(host.records.get(String(explicitShared.details?.worktreeId))?.setupRequired).toBe(true);
  });

  it("uses pnpm-workspace.yaml as a default signal", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo" }));
    commitFixtureChanges(repo);

    const failure = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-pnpm-workspace-default",
      mode: "new",
    }));

    expect(failure.code).toBe("WORKTREE_SETUP_REQUIRED");
    expect(host.records.get(String(failure.details?.worktreeId))).toMatchObject({
      setupMode: "shared_dependencies",
      setupRequired: true,
    });
  });

  it("keeps non-pnpm repository defaults at none and optional", async () => {
    const { service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-non-pnpm-default",
      mode: "new",
    });

    expect(created).toMatchObject({
      setupMode: "none",
      setupRequired: false,
      setupStatus: "not_requested",
    });
    expect(host.records.get(String(created.worktreeId))).toMatchObject({
      setupMode: "none",
      setupRequired: false,
    });
  });

  it("keeps explicit none independent in a pnpm repo and exposes the stored setup state", async () => {
    const { repo, service } = fixture();
    configurePnpmRepo(repo);
    commitFixtureChanges(repo);
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-none",
      mode: "new",
      setup: "none",
    });
    expect(created).toMatchObject({
      setupMode: "none",
      setupRequired: false,
      setupStatus: "not_requested",
    });
    expect(existsSync(join(String(created.path), "packages", "ui", "node_modules"))).toBe(false);
    const listed = await service.list({ actorSessionId: "owner", repoId: "demo" });
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: created.path,
        setupMode: "none",
        setupRequired: false,
        setupStatus: "not_requested",
      }),
      expect.objectContaining({
        discoveryKind: "base",
        setupMode: null,
        setupRequired: null,
        setupStatus: null,
      }),
    ]));
  });

  it("marks a shared setup ready only when a declared package-local runner is executable", async () => {
    const { repo, service } = fixture();
    configurePnpmRepo(repo);
    const sourceRunner = addRunner(repo, "packages/ui");
    commitFixtureChanges(repo);

    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-runner-ready",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });

    const linkedModules = join(String(created.path), "packages", "ui", "node_modules");
    expect(created).toMatchObject({ setupStatus: "ready", setupMode: "shared_dependencies", setupRequired: true });
    expect(lstatSync(linkedModules).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(linkedModules, ".bin", "vitest"))).toBe(realpathSync(sourceRunner));
  });

  it("rejects a missing source runner with its package path", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    mkdirSync(join(repo, "packages", "ui", "node_modules"), { recursive: true });
    commitFixtureChanges(repo);

    const failure = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-runner-missing",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    }));

    expect(failure.code).toBe("WORKTREE_SETUP_REQUIRED");
    expect(failure.details?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("packages/ui"),
      expect.stringContaining("vitest"),
    ]));
    expect(host.records.get(String(failure.details?.worktreeId))?.setupStatus).toBe("failed");

    const optional = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-runner-optional",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: false,
    });
    expect(optional).toMatchObject({
      setupMode: "shared_dependencies",
      setupRequired: false,
      setupStatus: "failed",
    });
    expect(optional.warnings).toEqual(expect.arrayContaining([expect.stringContaining("packages/ui")]));
  });

  it("inherits omitted setup settings and does not repair a missing link during reuse", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    addRunner(repo, "packages/ui");
    commitFixtureChanges(repo);
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-stale-link",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: false,
    });
    const linkedModules = join(String(created.path), "packages", "ui", "node_modules");
    rmSync(linkedModules);

    const reused = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-stale-link",
      mode: "existing",
    });

    expect(reused).toMatchObject({
      worktreeId: created.worktreeId,
      reused: true,
      setupMode: "shared_dependencies",
      setupRequired: false,
      setupStatus: "failed",
    });
    expect(reused.warnings).toEqual(expect.arrayContaining([expect.stringContaining("packages/ui") ]));
    expect(existsSync(linkedModules)).toBe(false);
    expect(host.records.get(String(created.worktreeId))?.setupStatus).toBe("failed");

    const mismatch = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-stale-link",
      mode: "existing",
      setup: "none",
    }));
    expect(mismatch.code).toBe("WORKTREE_SETUP_CONTRACT_MISMATCH");
  });

  it("does not repair a previously failed optional setup during reuse", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    commitFixtureChanges(repo);
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-failed-reuse",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: false,
    });
    expect(created).toMatchObject({ setupStatus: "failed" });
    addRunner(repo, "packages/ui");

    const reused = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-failed-reuse",
      mode: "existing",
    });

    expect(reused).toMatchObject({
      worktreeId: created.worktreeId,
      setupMode: "shared_dependencies",
      setupRequired: false,
      setupStatus: "failed",
    });
    expect(existsSync(join(String(created.path), "packages", "ui", "node_modules"))).toBe(false);
    expect(host.records.get(String(created.worktreeId))?.managedPaths).toEqual([]);
  });

  it("rechecks a required runner before returning a reused ready worktree", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo);
    const sourceRunner = addRunner(repo, "packages/ui");
    commitFixtureChanges(repo);
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-stale-runner",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });
    writeFileSync(sourceRunner, "#!/bin/sh\nexit 0\n");
    chmodSync(sourceRunner, 0o644);

    const failure = await captureWorktreeError(service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-stale-runner",
      mode: "existing",
    }));

    expect(failure.code).toBe("WORKTREE_SETUP_REQUIRED");
    expect(failure.details).toMatchObject({ worktreeId: created.worktreeId, setupStatus: "failed" });
    expect(failure.details?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("packages/ui"),
      expect.stringContaining("executable"),
    ]));
    expect(host.records.get(String(created.worktreeId))?.setupStatus).toBe("failed");
  });

  it("does not link or inspect Jest from an independent npm subproject", async () => {
    const { repo, service, host } = fixture();
    configurePnpmRepo(repo, { name: "ui" });
    const app = join(repo, "soul-app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "soul-app", devDependencies: { jest: "*" } }));
    writeFileSync(join(app, "package-lock.json"), "{}\n");
    addRunner(repo, "soul-app", "jest");
    mkdirSync(join(repo, "packages", "ui", "node_modules"), { recursive: true });
    commitFixtureChanges(repo);

    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/setup-independent-npm",
      mode: "new",
      setup: "shared_dependencies",
      requireSetup: true,
    });

    expect(created).toMatchObject({ setupStatus: "ready" });
    expect(host.records.get(String(created.worktreeId))?.managedPaths.map(({ path }) => path))
      .not.toContain("soul-app/node_modules");
    expect(existsSync(join(String(created.path), "soul-app", "node_modules"))).toBe(false);
  });

  it("keeps adoption defaults at none without changing existing links", async () => {
    const { projectsRoot, repo, service } = fixture();
    configurePnpmRepo(repo);
    const unmanaged = join(projectsRoot, "demo--adopt-default");
    git(repo, "worktree", "add", "-b", "feature/adopt-default", unmanaged, "HEAD");

    const adopted = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/adopt-default",
      mode: "adopt",
      adoptPath: unmanaged,
      expectedHead: git(unmanaged, "rev-parse", "HEAD"),
    });

    expect(adopted).toMatchObject({
      adopted: true,
      setupMode: "none",
      setupRequired: false,
      setupStatus: "not_requested",
    });
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

  it("preserves a stale registration when its branch ref changed", async () => {
    const { repo, service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/missing-path-ref-changed",
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
    writeFileSync(join(repo, "new-head.txt"), "new head\n");
    git(repo, "add", "new-head.txt");
    git(repo, "commit", "-m", "advance base for stale registration");
    git(
      repo,
      "update-ref",
      "refs/heads/feature/missing-path-ref-changed",
      git(repo, "rev-parse", "HEAD"),
    );

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({ code: "WORKTREE_HEAD_CHANGED" });
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(String(created.path));
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
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

  it("restores ready and finishes on retry when Git removal succeeded before DB transition failed", async () => {
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
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
  });

  it("finishes a partial removal without falling back to an ancestor repository", async () => {
    const { projectsRoot, repo, service, host } = fixture();
    git(projectsRoot, "init", "-b", "outer");
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/partial-remove-empty",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    const path = String(created.path);
    git(repo, "worktree", "remove", path);
    mkdirSync(path);
    const record = host.records.get(String(created.worktreeId))!;
    host.records.set(record.id, {
      ...record,
      branchDeleteExpectedSha: String(created.head),
    });

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).resolves.toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
    expect(host.records.get(String(created.worktreeId))?.state).toBe("removed");
    expect(git(repo, "rev-parse", "refs/heads/feature/partial-remove-empty"))
      .toBe(created.head);
  });

  it("preserves nonempty and dangling-symlink partial removal residues", async () => {
    for (const residue of ["nonempty", "dangling-symlink"] as const) {
      const { projectsRoot, repo, service, host } = fixture();
      const created = await service.create({
        actorSessionId: "owner",
        repoId: "demo",
        branch: `feature/partial-remove-${residue}`,
        mode: "new",
        setup: "none",
        requireSetup: false,
      });
      const path = String(created.path);
      git(repo, "worktree", "remove", path);
      if (residue === "nonempty") {
        mkdirSync(path);
        writeFileSync(join(path, "preserve.txt"), "user data\n");
      } else {
        symlinkSync(join(projectsRoot, "missing-target"), path);
      }
      const record = host.records.get(String(created.worktreeId))!;
      host.records.set(record.id, {
        ...record,
        branchDeleteExpectedSha: String(created.head),
      });

      await expect(service.remove({
        actorSessionId: "owner",
        worktreeId: String(created.worktreeId),
      })).rejects.toMatchObject({ code: "WORKTREE_PARTIAL_REMOVE_RESIDUE" });
      expect(lstatSync(path)).toBeDefined();
      if (residue === "nonempty") {
        expect(existsSync(join(path, "preserve.txt"))).toBe(true);
      } else {
        expect(lstatSync(path).isSymbolicLink()).toBe(true);
      }
      expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
    }
  });

  it("preserves an unregistered residue without a durable removal HEAD", async () => {
    const { repo, service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/partial-remove-unrecorded",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    const path = String(created.path);
    git(repo, "worktree", "remove", path);
    mkdirSync(path);

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({ code: "WORKTREE_REMOVAL_HEAD_UNRECORDED" });
    expect(existsSync(path)).toBe(true);
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
  });

  it("preserves an unregistered residue when the branch ref was reused", async () => {
    const { repo, service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/partial-remove-ref-reused",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    const path = String(created.path);
    git(repo, "worktree", "remove", path);
    mkdirSync(path);
    writeFileSync(join(repo, "after.txt"), "new base head\n");
    git(repo, "add", "after.txt");
    git(repo, "commit", "-m", "advance base");
    git(repo, "branch", "-f", "feature/partial-remove-ref-reused", "HEAD");
    const record = host.records.get(String(created.worktreeId))!;
    host.records.set(record.id, {
      ...record,
      branchDeleteExpectedSha: String(created.head),
    });

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({ code: "WORKTREE_HEAD_CHANGED" });
    expect(existsSync(path)).toBe(true);
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
  });

  it("preserves a registered worktree whose durable identity changed", async () => {
    const { repo, service, host } = fixture();
    const created = await service.create({
      actorSessionId: "owner",
      repoId: "demo",
      branch: "feature/remove-identity-changed",
      mode: "new",
      setup: "none",
      requireSetup: false,
    });
    const privateGitDirectory = resolve(
      String(created.path),
      git(String(created.path), "rev-parse", "--git-dir"),
    );
    writeFileSync(join(privateGitDirectory, "soulstream-worktree-id"), "different-id\n");

    await expect(service.remove({
      actorSessionId: "owner",
      worktreeId: String(created.worktreeId),
    })).rejects.toMatchObject({ code: "WORKTREE_IDENTITY_CHANGED" });
    expect(existsSync(String(created.path))).toBe(true);
    expect(host.records.get(String(created.worktreeId))?.state).toBe("ready");
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
  readonly records = new Map<string, WorktreeRecord & { lastSessionActivityAt?: string; linkedCardsClosed?: boolean }>();
  registerFailuresRemaining = 0;
  finishRemoveFailuresRemaining = 0;

  async sweepCandidates(input: { nodeId: string }) {
    return [...this.records.values()].filter(record => record.nodeId === input.nodeId && record.state === "ready")
      .map(record => ({ ...record, lastSessionActivityAt: record.lastSessionActivityAt!, linkedCardsClosed: record.linkedCardsClosed ?? false }));
  }

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
