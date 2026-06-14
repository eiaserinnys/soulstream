import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function resolveClaudeExecutableFromPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue) return undefined;

  const candidateNames = platform === "win32" ? ["claude.exe"] : ["claude"];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return undefined;
}
