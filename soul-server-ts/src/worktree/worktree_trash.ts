import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";

function trashRoot(projectsRoot: string): string {
  return join(projectsRoot, ".worktree-trash");
}

function assertTrashDirectory(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid worktree trash directory: ${root}`);
}

export async function newTrashPath(projectsRoot: string): Promise<string> {
  const root = trashRoot(projectsRoot);
  await fs.mkdir(root, { recursive: true });
  assertTrashDirectory(root);
  return join(root, randomUUID());
}

export function cleanupTrashItem(projectsRoot: string, item: string): Promise<void> {
  const root = trashRoot(projectsRoot);
  assertTrashDirectory(root);
  return fs.rm(join(root, item), { recursive: true, force: true });
}

export async function sweepTrash(projectsRoot: string): Promise<void> {
  const root = trashRoot(projectsRoot);
  try {
    assertTrashDirectory(root);
    for (const item of await fs.readdir(root)) {
      try {
        await cleanupTrashItem(projectsRoot, item);
      } catch (error) {
        console.warn("Worktree trash cleanup failed", { item, error });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Worktree trash sweep failed", { error });
  }
}
