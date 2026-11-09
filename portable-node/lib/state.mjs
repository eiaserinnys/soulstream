import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeStateFile(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") await chmod(path, mode);
}

export async function ensureStateLayout(stateRoot) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(stateRoot, 0o700);
  for (const dir of [
    "runtimes",
    "config",
    "releases",
    "outbox",
    "cache",
    "incoming",
    "codex",
    "claude-accounts",
    "home",
    "tmp",
    "git",
    "r",
    "bin",
    "runner/releases",
  ]) {
    await mkdir(join(stateRoot, dir), { recursive: true, mode: 0o700 });
  }
}
