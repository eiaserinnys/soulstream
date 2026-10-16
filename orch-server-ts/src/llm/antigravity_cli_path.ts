import { accessSync, constants, statSync } from "node:fs";
import { delimiter, posix, win32 } from "node:path";

type PathSource = "AGY_CLI_PATH" | "PATH" | "HOME_LOCAL_BIN";
export function resolveAntigravityCliPath(
  configuredPath: string | null | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { readonly path: string; readonly source: PathSource } | undefined {
  const pathApi = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? ["agy.cmd", "agy.exe", "agy.bat", "agy.com"] : ["agy"];
  const candidates: Array<{ path: string; source: PathSource }> = [];
  const explicit = (configuredPath ?? env.AGY_CLI_PATH)?.trim();
  if (explicit) candidates.push({ path: explicit, source: "AGY_CLI_PATH" });
  const path = env.PATH ?? (platform === "win32" ? env.Path : undefined);
  for (const directory of (path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
    for (const name of names) candidates.push({ path: pathApi.join(directory, name), source: "PATH" });
  }
  if (env.HOME) {
    for (const name of names) candidates.push({ path: pathApi.join(env.HOME, ".local", "bin", name), source: "HOME_LOCAL_BIN" });
  }
  return candidates.find(candidate => {
    try {
      if (!statSync(candidate.path).isFile()) return false;
      if (platform === "win32") return /\.(cmd|exe|bat|com)$/i.test(candidate.path);
      accessSync(candidate.path, constants.X_OK);
      return true;
    } catch { return false; }
  });
}
