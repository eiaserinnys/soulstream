import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { baseDependencyLinksIntoWorktree, collectBaseDependencyLinks, dependencyLinksIntoWorktree } from "../src/worktree/worktree_dependency_links.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("collects once without following links and filters both readlink and realpath targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktree-links-")); roots.push(root);
  const base = join(root, "base"), worktree = join(root, "base--work"), sibling = `${worktree}-other`;
  mkdirSync(join(base, "node_modules"), { recursive: true });
  mkdirSync(worktree); mkdirSync(sibling);
  const alias = join(root, "alias"); symlinkSync(worktree, alias, "dir");
  symlinkSync(alias, join(base, "node_modules", "alias"), "dir");
  symlinkSync(worktree, join(base, "node_modules", "direct"), "dir");
  symlinkSync(join(worktree, "missing"), join(base, "node_modules", "missing"), "dir");
  symlinkSync(sibling, join(base, "node_modules", "sibling"), "dir");
  const inventory = await collectBaseDependencyLinks(base);
  expect(inventory).toHaveLength(4);
  expect(inventory).toContainEqual({ path: "node_modules/alias", target: alias, resolvedTarget: worktree });
  const matching = [
    { path: "node_modules/alias", target: worktree },
    { path: "node_modules/direct", target: worktree },
    { path: "node_modules/missing", target: join(worktree, "missing") },
  ];
  expect(dependencyLinksIntoWorktree(inventory, worktree)).toEqual(matching);
  expect(await baseDependencyLinksIntoWorktree(base, worktree)).toEqual(matching);
  expect(dependencyLinksIntoWorktree(inventory, alias)).toEqual([{ path: "node_modules/alias", target: worktree }]);
});
