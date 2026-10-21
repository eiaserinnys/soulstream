import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { nodeModulesDirectories } from "./worktree_setup.js";

export interface BaseDependencyLink {
  path: string;
  target: string;
}

export interface CollectedBaseDependencyLink extends BaseDependencyLink {
  resolvedTarget: string;
}

export async function baseDependencyLinksIntoWorktree(base: string, worktree: string): Promise<BaseDependencyLink[]> {
  return dependencyLinksIntoWorktree(await collectBaseDependencyLinks(base), worktree);
}

/** Inspect dependency directories without traversing symlinks into other workspaces. */
export async function collectBaseDependencyLinks(base: string): Promise<CollectedBaseDependencyLink[]> {
  const links: CollectedBaseDependencyLink[] = [];
  const visit = async (path: string, entry?: Dirent): Promise<void> => {
    const stat = entry ?? await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path));
      let resolvedTarget = target;
      try {
        resolvedTarget = await realpath(path);
      } catch (error) {
        // A dangling link still records which workspace it depends on.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      links.push({ path: relative(base, path).replaceAll("\\", "/"), target, resolvedTarget });
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) await visit(join(path, entry.name), entry);
      }
    }
  };
  for (const directory of await nodeModulesDirectories(base)) await visit(directory);
  return links.sort((left, right) => left.path.localeCompare(right.path));
}

export function dependencyLinksIntoWorktree(
  links: readonly CollectedBaseDependencyLink[],
  worktree: string,
): BaseDependencyLink[] {
  return links
    .filter(link => containsPath(worktree, link.target) || containsPath(worktree, link.resolvedTarget))
    .map(link => ({ path: link.path, target: link.resolvedTarget }));
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
