import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSnapshotCache } from "../../src/workspace/workspace_snapshot.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
describe("workspace snapshot", () => {
  it("reports status, rename, line counts and commits, and filters shared cache by since", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-git-")); roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: {...process.env, GIT_AUTHOR_DATE:"2025-01-01T00:00:00Z", GIT_COMMITTER_DATE:"2025-01-01T00:00:00Z"} });
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    await writeFile(path.join(root, "tracked.txt"), "one\n"); await writeFile(path.join(root, "old.txt"), "rename\n"); git("add", "."); git("commit", "-m", "initial");
    git("mv", "old.txt", "renamed.txt");
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n"); await writeFile(path.join(root, "new.txt"), "new\n");
    await writeFile(path.join(root, "added.txt"), "added\n"); git("add", "added.txt");
    const cache = new WorkspaceSnapshotCache();
    const first = await cache.get(root, "2024-01-01T00:00:00.000Z");
    expect(first.state).toBe("ready");
    expect(first.git?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({path:"tracked.txt",status:"modified",added:1,deleted:0}),
      expect.objectContaining({path:"new.txt",status:"untracked",added:null}),
      expect.objectContaining({path:"added.txt",status:"added"}),
      expect.objectContaining({path:"renamed.txt",status:"renamed",orig_path:"old.txt"}),
    ]));
    expect(first.git?.commits[0]?.files).toContain("tracked.txt");
    const later = await cache.get(root, "2026-01-01T00:00:00.000Z");
    expect(later.observed_at).toBe(first.observed_at);
    expect(later.git?.commits).toEqual([]);
    expect((await cache.get(root, "2024-01-01T00:00:00.000Z")).git?.commits).toHaveLength(1);
  });
  it("reports every untracked file in a new folder with its size", async () => {
    const root=await mkdtemp(path.join(tmpdir(),"workspace-nested-")); roots.push(root);
    execFileSync("git",["init"],{cwd:root});
    execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-m","initial"],{cwd:root});
    await mkdir(path.join(root,"src","new"),{recursive:true});
    await writeFile(path.join(root,"src","new","a.ts"),"one");
    await writeFile(path.join(root,"src","new","b.ts"),"four");
    const snapshot=await new WorkspaceSnapshotCache().get(root,"2024-01-01T00:00:00.000Z");
    expect(snapshot.git?.files).toEqual([
      expect.objectContaining({path:"src/new/a.ts",status:"untracked",size:3}),
      expect.objectContaining({path:"src/new/b.ts",status:"untracked",size:4}),
    ]);
  });
  it("truncates more than 1000 changed files", async () => {
    const root=await mkdtemp(path.join(tmpdir(),"workspace-limit-")); roots.push(root);
    execFileSync("git",["init"],{cwd:root});
    execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-m","initial"],{cwd:root});
    await Promise.all(Array.from({length:1001},(_,i)=>writeFile(path.join(root,`file-${i}.txt`),"x")));
    const snapshot=await new WorkspaceSnapshotCache().get(root,"2024-01-01T00:00:00.000Z");
    expect(snapshot.git?.truncated).toBe(true); expect(snapshot.git?.files).toHaveLength(1000);
  });
  it("returns pending when a calculation outlives its wait, then returns its result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-pending-")); roots.push(root);
    const cache = new WorkspaceSnapshotCache(5);
    let finish!: (value: any) => void;
    const delayed = new Promise<any>(resolve => { finish=resolve; });
    vi.spyOn(cache as any, "compute").mockReturnValue(delayed);
    expect((await cache.get(root,"2024-01-01T00:00:00.000Z")).state).toBe("pending");
    finish({root,state:"not_git",observed_at:"2025-01-01T00:00:00.000Z",refreshing:false,git:null});
    await delayed;
    expect((await cache.get(root,"2024-01-01T00:00:00.000Z")).state).toBe("not_git");
  });
});

it("preserves backslashes in POSIX file names", async () => {
  if (process.platform === "win32") return;
  const root=await mkdtemp(path.join(tmpdir(),"workspace-backslash-")); roots.push(root);
  execFileSync("git",["init","-q"],{cwd:root});
  execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","initial"],{cwd:root});
  await writeFile(path.join(root,"a\\b"),"x");
  const snapshot=await new WorkspaceSnapshotCache().get(root,"2024-01-01T00:00:00.000Z");
  expect(snapshot.git?.files.map(file=>file.path)).toContain("a\\b");
  expect(snapshot.git?.files.map(file=>file.path)).not.toContain("a/b");
});
