import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { WorktreeGit } from "../src/worktree/worktree_git.js";
import { runBoundedProcess } from "../src/worktree/worktree_process.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepository(): { projectsRoot: string; repo: string } {
  const projectsRoot = mkdtempSync(join(tmpdir(), "worktree-git-"));
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
  return { projectsRoot, repo };
}

describe("WorktreeGit", () => {
  it("creates a marked linked worktree without changing the base checkout", async () => {
    const { projectsRoot, repo } = makeRepository();
    const baseBranch = git(repo, "branch", "--show-current");
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });

    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/한글-worktree",
      mode: "new",
      worktreeId: "worktree-1",
    });

    expect(created.kind).toBe("managed");
    expect(created.identity).toBe("worktree-1");
    expect(git(repo, "branch", "--show-current")).toBe(baseBranch);
    expect((await worktrees.list("demo")).map((item) => item.kind))
      .toEqual(expect.arrayContaining(["base", "managed"]));
  });

  it("reports ignored output separately and never treats a real node_modules directory as managed", async () => {
    const { projectsRoot } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/dirty",
      mode: "new",
      worktreeId: "worktree-2",
    });
    mkdirSync(join(created.path, "dist"));
    writeFileSync(join(created.path, "dist", "bundle.js"), "generated");
    mkdirSync(join(created.path, "node_modules"));
    writeFileSync(join(created.path, "node_modules", "local.txt"), "local");

    const dirty = await worktrees.inspectDirty(created.path, []);
    expect(dirty.ignored).toEqual(expect.arrayContaining([
      "dist/",
      "node_modules/",
    ]));
    expect(dirty.clean).toBe(false);
  });

  it("reports both paths of a tracked rename without corrupting either name", async () => {
    const { projectsRoot } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/rename-dirty",
      mode: "new",
      worktreeId: "worktree-rename-dirty",
    });
    git(created.path, "mv", "README.md", "RENAMED.md");

    const dirty = await worktrees.inspectDirty(created.path, []);

    expect(dirty.tracked.sort()).toEqual(["README.md", "RENAMED.md"]);
    expect(dirty.clean).toBe(false);
  });

  it("refuses to mutate a path whose durable identity changed", async () => {
    const { projectsRoot } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/identity",
      mode: "new",
      worktreeId: "worktree-3",
    });

    await expect(worktrees.assertIdentity(created.path, "different-id"))
      .rejects.toMatchObject({ code: "WORKTREE_IDENTITY_CHANGED" });
  });

  it("keeps new and existing branch semantics explicit without resetting refs", async () => {
    const { projectsRoot, repo } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    git(repo, "branch", "feature/existing", "HEAD");
    const existingHead = git(repo, "rev-parse", "refs/heads/feature/existing");

    const existing = await worktrees.create({
      repoId: "demo",
      branch: "feature/existing",
      mode: "existing",
      worktreeId: "worktree-existing",
    });
    expect(existing.head).toBe(existingHead);
    expect(git(repo, "rev-parse", "refs/heads/feature/existing")).toBe(existingHead);

    await expect(worktrees.create({
      repoId: "demo",
      branch: "feature/existing",
      mode: "new",
      worktreeId: "worktree-duplicate",
    })).rejects.toMatchObject({ code: "BRANCH_ALREADY_EXISTS" });
    await expect(worktrees.create({
      repoId: "demo",
      branch: "feature/invalid branch",
      mode: "new",
      worktreeId: "worktree-invalid",
    })).rejects.toMatchObject({ code: "INVALID_BRANCH" });
  });

  it("discovers only primary repositories and classifies out-of-root worktrees as external", async () => {
    const { projectsRoot, repo } = makeRepository();
    const externalRoot = mkdtempSync(join(tmpdir(), "worktree-external-"));
    roots.push(externalRoot);
    const external = join(externalRoot, "demo-external");
    git(repo, "worktree", "add", "-b", "feature/external", external, "HEAD");
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    await worktrees.create({
      repoId: "demo",
      branch: "feature/managed",
      mode: "new",
      worktreeId: "worktree-managed",
    });

    expect(worktrees.listRepositoryIds()).toEqual(["demo"]);
    expect((await worktrees.list("demo")).find((entry) => entry.path === external))
      .toMatchObject({ kind: "external" });
  });

  it("never deletes a same-name branch recreated after the deletion marker committed", async () => {
    const { projectsRoot, repo } = makeRepository();
    const remote = join(projectsRoot, "remote.git");
    mkdirSync(remote);
    git(remote, "init", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/delete-once",
      mode: "new",
      worktreeId: "worktree-delete-once",
      startPoint: "refs/remotes/origin/main",
    });
    writeFileSync(join(created.path, "feature.txt"), "feature\n");
    git(created.path, "add", "feature.txt");
    git(created.path, "commit", "-m", "feature commit");
    git(repo, "push", "origin", "feature/delete-once");
    await worktrees.remove({
      repoId: "demo",
      path: created.path,
      worktreeId: "worktree-delete-once",
      managedPaths: [],
    });
    const expectedSha = git(repo, "rev-parse", "refs/heads/feature/delete-once");
    const markerRef = "refs/soulstream/worktree-deletions/worktree-delete-once";

    await expect(worktrees.deleteBranch({
      repoId: "demo",
      branch: "feature/delete-once",
      expectedSha,
      markerRef,
    })).resolves.toBe("deleted");
    git(repo, "branch", "feature/delete-once", "HEAD");
    await expect(worktrees.deleteBranch({
      repoId: "demo",
      branch: "feature/delete-once",
      expectedSha,
      markerRef,
    })).resolves.toBe("already_deleted");
    expect(git(repo, "rev-parse", "refs/heads/feature/delete-once")).not.toBe(expectedSha);
  });

  it("refuses a same-name branch replaced before the first deletion attempt", async () => {
    const { projectsRoot, repo } = makeRepository();
    const remote = join(projectsRoot, "replacement-remote.git");
    mkdirSync(remote);
    git(remote, "init", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/reused-before-delete",
      mode: "new",
      worktreeId: "worktree-reused-before-delete",
      startPoint: "refs/remotes/origin/main",
    });
    writeFileSync(join(created.path, "feature.txt"), "feature\n");
    git(created.path, "add", "feature.txt");
    git(created.path, "commit", "-m", "feature commit");
    git(repo, "push", "origin", "feature/reused-before-delete");
    const expectedSha = git(created.path, "rev-parse", "HEAD");
    await worktrees.remove({
      repoId: "demo",
      path: created.path,
      worktreeId: "worktree-reused-before-delete",
      managedPaths: [],
    });
    git(repo, "branch", "-D", "feature/reused-before-delete");
    git(repo, "branch", "feature/reused-before-delete", "main");

    await expect(worktrees.deleteBranch({
      repoId: "demo",
      branch: "feature/reused-before-delete",
      expectedSha,
      markerRef: "refs/soulstream/worktree-deletions/worktree-reused-before-delete",
    })).rejects.toMatchObject({ code: "REF_REUSED" });
    expect(git(repo, "rev-parse", "refs/heads/feature/reused-before-delete"))
      .toBe(git(repo, "rev-parse", "main"));
  });

  it("restores managed dependency links when Git removal refuses the worktree", async () => {
    const { projectsRoot, repo } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });
    const created = await worktrees.create({
      repoId: "demo",
      branch: "feature/remove-failure",
      mode: "new",
      worktreeId: "worktree-remove-failure",
    });
    const target = join(repo, "node_modules");
    mkdirSync(target);
    const link = join(created.path, "node_modules");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(created.path, "README.md"), "modified\n");

    await expect(worktrees.remove({
      repoId: "demo",
      path: created.path,
      worktreeId: "worktree-remove-failure",
      managedPaths: [{ path: "node_modules", target }],
    })).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(realpathSync(link)).toBe(realpathSync(target));
  });

  it("validates branch names before feeding update-ref stdin", async () => {
    const { projectsRoot } = makeRepository();
    const worktrees = new WorktreeGit({ projectsRoot, timeoutMs: 5_000 });

    await expect(worktrees.deleteBranch({
      repoId: "demo",
      branch: "feature/ok\ndelete refs/heads/main",
      expectedSha: "a".repeat(40),
      markerRef: "refs/soulstream/worktree-deletions/test",
    })).rejects.toMatchObject({ code: "INVALID_BRANCH" });
  });

  it("shares one deadline across sequential Git child processes", async () => {
    const { projectsRoot } = makeRepository();
    const calls: string[][] = [];
    const worktrees = new WorktreeGit({
      projectsRoot,
      timeoutMs: 300,
      processRunner: async (input) => {
        calls.push(input.args);
        if (input.args[0] === "remote" || input.args[0] === "fetch") {
          await runBoundedProcess({
            command: process.execPath,
            args: ["-e", "setTimeout(()=>{},180)"],
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
          });
        }
        return {
          stdout: input.args[0] === "remote" ? "git@example.invalid:demo.git\n" : "",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    await expect(worktrees.withOperationDeadline(async () => await worktrees.create({
      repoId: "demo",
      branch: "feature/shared-deadline",
      mode: "new",
      worktreeId: "worktree-shared-deadline",
    }))).rejects.toMatchObject({ code: "PROCESS_TIMEOUT", terminationConfirmed: true });
    expect(calls.map((args) => args[0])).toEqual([
      "check-ref-format",
      "remote",
      "fetch",
    ]);
  });
});
