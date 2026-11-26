import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** projectsRoot 바로 아래에서 `.git` 디렉터리를 가진 저장소 이름을 정렬해 돌려준다. */
export function listRepositoryIds(projectsRoot: string): string[] {
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => {
      const entryPath = join(projectsRoot, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = realpathSync(entryPath);
          if (!statSync(target).isDirectory() || isPathInside(target, projectsRoot)) return false;
          const gitPath = join(target, ".git");
          return lstatSync(gitPath).isDirectory() && !existsSync(join(gitPath, "commondir"));
        } catch {
          return false;
        }
      }
      if (!entry.isDirectory()) return false;
      const gitPath = join(entryPath, ".git");
      return existsSync(gitPath) && lstatSync(gitPath).isDirectory();
    })
    .map((entry) => entry.name)
    .sort();
}
