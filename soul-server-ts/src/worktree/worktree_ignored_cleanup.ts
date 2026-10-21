import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Remove only the ignored inventory, yielding between entries so the operation deadline can stop it. */
export async function removeIgnoredWorktreePaths(
  worktree: string,
  ignored: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const root = await fs.realpath(worktree);
  const removeEntry = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const stat = await fs.lstat(path);
    signal?.throwIfAborted();
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const entry of await fs.readdir(path)) await removeEntry(join(path, entry));
      signal?.throwIfAborted();
      await fs.rmdir(path);
    } else {
      await fs.unlink(path);
    }
  };
  for (const entry of ignored) {
    signal?.throwIfAborted();
    const path = resolve(root, entry);
    if (!inside(root, path)) continue;
    const parent = await fs.realpath(dirname(path));
    if (parent !== root && !inside(root, parent)) continue;
    await removeEntry(path);
  }
  signal?.throwIfAborted();
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
