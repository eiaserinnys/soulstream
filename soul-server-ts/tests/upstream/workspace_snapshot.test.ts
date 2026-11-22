import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSnapshotCache } from "../../src/workspace/workspace_snapshot.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
describe("workspace snapshot", () => {
  it("reports git status, line counts and commits and shares cached results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-git-")); roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    await writeFile(path.join(root, "tracked.txt"), "one\n"); git("add", "."); git("commit", "-m", "initial");
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n"); await writeFile(path.join(root, "new.txt"), "new\n");
    const cache = new WorkspaceSnapshotCache();
    const first = await cache.get(root, "2000-01-01T00:00:00.000Z");
    expect(first.state).toBe("ready");
    expect(first.git?.files).toEqual(expect.arrayContaining([expect.objectContaining({path: "tracked.txt", status: "modified", added: 1, deleted: 0}), expect.objectContaining({path: "new.txt", status: "untracked", added: null})]));
    expect(first.git?.commits[0]?.files).toContain("tracked.txt");
    expect((await cache.get(root, "2000-01-01T00:00:00.000Z")).observed_at).toBe(first.observed_at);
  });
});
