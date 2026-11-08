import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/**
 * Resolve symlinks in the existing ancestors of a worktree path.
 *
 * macOS exposes the same directory through both /tmp and /private/tmp, so
 * lexical comparisons reject paths that Git reports through another alias.
 * Missing trailing segments are appended to the real path of the nearest
 * existing ancestor so creation and removal agree before the directory exists.
 * Only ENOENT walks up; other resolution errors propagate.
 */
export function canonicalWorktreePath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      const real = realpathSync(candidate);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}
