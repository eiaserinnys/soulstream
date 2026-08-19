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

export function resolveRegisteredRunnerPid(
  pidFilePid: number | null,
  lifecyclePid: number | null,
  identityPid: number | null,
  label: string,
  candidateIsAlive: (pid: number) => boolean = isProcessAlive,
): number | null {
  const candidates = [pidFilePid, lifecyclePid, identityPid]
    .filter((pid): pid is number => pid !== null);
  const uniqueCandidates = [...new Set(candidates)];
  if (
    uniqueCandidates.length > 1
    && uniqueCandidates.filter(candidateIsAlive).length > 0
  ) {
    throw new Error(`runner pid evidence disagrees: ${label}`);
  }
  // Mismatched dead evidence is stale registration residue, not split brain.
  // Prefer the identity owner so later identity checks remain authoritative.
  return identityPid ?? pidFilePid ?? lifecyclePid ?? null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
