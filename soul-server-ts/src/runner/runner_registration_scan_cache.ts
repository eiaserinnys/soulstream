import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { RunnerRegistration } from "./runner_process_registry.js";
import { isProcessAlive } from "./runner_process_lock.js";
import { runnerHostStatePath } from "./runner_host_state_store.js";

const FULL_RECHECK_INTERVAL_MS = 300_000;
type Entry = { fingerprint: string; registration: RunnerRegistration; checkedAt: number };

/** Memory owned by a periodic scanner, never by destructive readers. */
export class RunnerRegistrationScanCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  async read(
    directory: string,
    readFresh: () => Promise<RunnerRegistration>,
  ): Promise<RunnerRegistration> {
    const before = await fingerprint(directory);
    const cached = this.entries.get(directory);
    if (cached && cached.fingerprint === before
      && this.now() - cached.checkedAt < FULL_RECHECK_INTERVAL_MS
      && (cached.registration.pid === null || !isProcessAlive(cached.registration.pid))) {
      // Callers may annotate the recovered registration; keep the stored proof isolated.
      return structuredClone(cached.registration);
    }
    this.entries.delete(directory);
    const registration = await readFresh();
    if (canCache(registration) && before === await fingerprint(directory)) {
      this.entries.set(directory, {
        fingerprint: before,
        registration: structuredClone(registration),
        checkedAt: this.now(),
      });
    }
    return registration;
  }

  prune(directories: Set<string>): void {
    for (const directory of this.entries.keys()) {
      if (!directories.has(directory)) this.entries.delete(directory);
    }
  }
}

function canCache(registration: RunnerRegistration): boolean {
  if (registration.pidAlive) return false;
  if (registration.retiredAt) return true;
  const state = registration.lifecycle?.execution_state;
  return state === "reaped" || (state === "closed"
    && (registration.closedTailState?.status === "fully_acknowledged"
      || registration.closedTailState?.status === "empty_prebootstrap"));
}

async function fingerprint(directory: string): Promise<string> {
  const database = join(directory, "runner.sqlite");
  const host = runnerHostStatePath(database);
  const paths = [
    join(directory, "runner-config.json"), join(directory, "runner-identity.json"),
    join(directory, "runner.pid"), join(directory, "runner.lock"),
    join(directory, "runner-lifecycle.json"),
    database, `${database}-wal`, host, `${host}-wal`,
  ];
  return JSON.stringify(await Promise.all(paths.map(async (path) => {
    try {
      const file = await stat(path, { bigint: true });
      return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  })));
}
