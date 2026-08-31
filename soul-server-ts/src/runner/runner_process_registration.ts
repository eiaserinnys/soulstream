import { readFile } from "node:fs/promises";

export async function readRunnerPid(path: string): Promise<number | null> {
  try {
    const value = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid runner pid file: ${path}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
