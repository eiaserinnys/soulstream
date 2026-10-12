import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { nodeModulesDirectories } from "./worktree_setup.js";

export interface BaseDependencyLink {
  path: string;
  target: string;
}

/** Inspect dependency directories without traversing symlinks into other workspaces. */
export function baseDependencyLinksIntoWorktree(base: string, worktree: string): BaseDependencyLink[] {
  const links: BaseDependencyLink[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      let resolvedTarget = target;
      try {
        resolvedTarget = realpathSync(path);
      } catch (error) {
        // A dangling link still records which workspace it depends on.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (containsPath(worktree, target) || containsPath(worktree, resolvedTarget)) {
        links.push({ path: relative(base, path).replaceAll("\\", "/"), target: resolvedTarget });
      }
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    }
  };
  for (const directory of nodeModulesDirectories(base)) visit(directory);
  return links.sort((left, right) => left.path.localeCompare(right.path));
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
