import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { RunnerKernelLock } from "../runner/runner_kernel_lock.js";

/** Restore the SDK's JSONL and subagent sidecars in the selected profile's shared projects tree. */
export async function materializeClaudeAccountTranscript(
  store: SessionStore,
  configDir: string,
  key: SessionKey,
): Promise<void> {
  const projects = await realpath(join(configDir, "projects"));
  const projectDir = resolve(projects, key.projectKey);
  const mainPath = resolve(projectDir, `${key.sessionId}.jsonl`);
  if (dirname(projectDir) !== projects || dirname(mainPath) !== projectDir) {
    throw new Error("Invalid Claude transcript session key");
  }
  let lock: RunnerKernelLock | null = null;
  while (!lock) {
    lock = await RunnerKernelLock.tryAcquire(mainPath);
    if (!lock) await new Promise((done) => setTimeout(done, 25));
  }
  try {
    const entries = await store.load(key);
    if (!entries?.length) return;
    await writeTranscriptIfNewer(mainPath, entries);
    const subkeys = await store.listSubkeys?.({ projectKey: key.projectKey, sessionId: key.sessionId }) ?? [];
    const subRoot = resolve(projectDir, key.sessionId);
    for (const subpath of subkeys) {
      const subPath = resolve(subRoot, `${subpath}.jsonl`);
      if (!subpath || isAbsolute(subpath) || subpath.split(/[\\/]/).includes("..")
        || !subPath.startsWith(`${subRoot}${sep}`)) continue;
      const subEntries = await store.load({ ...key, subpath });
      if (!subEntries?.length) continue;
      const metadata = subEntries.filter((entry) => entry.type === "agent_metadata").at(-1);
      const transcript = subEntries.filter((entry) => entry.type !== "agent_metadata");
      const updated = transcript.length > 0 && await writeTranscriptIfNewer(subPath, transcript);
      if (metadata) {
        const metaPath = subPath.replace(/\.jsonl$/, ".meta.json");
        const { type: _type, ...body } = metadata;
        if (updated || await readIfPresent(metaPath) === null) {
          await atomicWrite(metaPath, JSON.stringify(body));
        }
      }
    }
  } finally {
    await lock.release();
  }
}

async function writeTranscriptIfNewer(path: string, entries: SessionStoreEntry[]): Promise<boolean> {
  const current = await readIfPresent(path);
  if (current !== null) {
    const local = current.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionStoreEntry);
    if (!databaseIsNewer(local, entries)) return false;
  }
  await atomicWrite(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return true;
}

function databaseIsNewer(local: SessionStoreEntry[], stored: SessionStoreEntry[]): boolean {
  const shared = Math.min(local.length, stored.length);
  if (local.slice(0, shared).every((entry, index) => isDeepStrictEqual(entry, stored[index]))) {
    return stored.length > local.length;
  }
  const latest = (entries: SessionStoreEntry[]) => entries.reduce((time, entry) => {
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return Number.isNaN(timestamp) ? time : Math.max(time, timestamp);
  }, 0);
  const localTime = latest(local);
  const storedTime = latest(stored);
  return localTime && storedTime ? storedTime > localTime : stored.length > local.length;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
