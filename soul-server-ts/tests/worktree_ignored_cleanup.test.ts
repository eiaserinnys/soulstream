import { promises as fs, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeIgnoredWorktreePaths } from "../src/worktree/worktree_ignored_cleanup.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ignored-cleanup-")); roots.push(root);
  const worktree = join(root, "worktree"), ignored = join(worktree, "node_modules");
  mkdirSync(ignored, { recursive: true });
  writeFileSync(join(worktree, "README.md"), "tracked");
  return { root, worktree, ignored };
}

it("skips paths outside the worktree and unlinks external symlinks without following them", async () => {
  const { root, worktree, ignored } = fixture(), external = join(root, "outside");
  mkdirSync(external); writeFileSync(join(external, "user.txt"), "preserve");
  symlinkSync(external, join(ignored, "escape"), "dir");
  await removeIgnoredWorktreePaths(worktree, ["../outside", external, "node_modules/escape/user.txt", "node_modules/"]);
  expect(readFileSync(join(external, "user.txt"), "utf8")).toBe("preserve");
  expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("tracked");
  expect(readdirSync(worktree)).toEqual(["README.md"]);
});

it.each(["node_modules/", "node_modules/a"])("stops ignored cleanup on abort and can resume (%s)", async (entry) => {
  const { worktree, ignored } = fixture();
  writeFileSync(join(ignored, "a"), "ignored"); writeFileSync(join(ignored, "b"), "ignored");
  const controller = new AbortController(), unlink = fs.unlink;
  vi.spyOn(fs, "unlink").mockImplementationOnce(async path => { await unlink(path); controller.abort(); });
  await expect(removeIgnoredWorktreePaths(worktree, [entry], controller.signal))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(readdirSync(ignored)).toHaveLength(1);
  expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("tracked");
  await removeIgnoredWorktreePaths(worktree, ["node_modules/"]);
  expect(readdirSync(worktree)).toEqual(["README.md"]);
});
