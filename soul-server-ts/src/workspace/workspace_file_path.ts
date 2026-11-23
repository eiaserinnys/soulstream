import { realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

export async function validateWorkspacePath(root: string, file: string, allowMissing = false): Promise<{target:string; info:Stats | null}> {
  const base = await realpath(root).catch(() => { throw new Error("NOT_FOUND: workspace not found"); });
  const candidate = path.resolve(base, file);
  const check = (target:string) => {
    const rel = path.relative(base, target);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("INVALID_REQUEST: path outside workspace");
  };
  check(candidate);
  let target = await realpath(candidate).catch(() => null);
  if (!target && allowMissing) {
    let parent = path.dirname(candidate);
    while (!(target = await realpath(parent).catch(() => null))) {
      const next = path.dirname(parent); if (next === parent) throw new Error("NOT_FOUND: file not found"); parent = next;
    }
    check(target);
    return {target:candidate, info:null};
  }
  if (!target) throw new Error("NOT_FOUND: file not found");
  check(target);
  const info = await stat(target).catch(() => { throw new Error("NOT_FOUND: file not found"); });
  if (!info.isFile()) throw new Error("NOT_FOUND: not a regular file");
  return {target, info};
}
