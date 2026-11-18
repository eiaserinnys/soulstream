import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { RunnerRegistration } from "./runner_process_registry.js";
import { RunnerChildConfigSchema } from "./runner_child_config.js";
import { canCache, type RunnerRegistrationScanCache, type RunnerRegistrationSnapshotEntry } from "./runner_registration_scan_cache.js";

const VERSION = 1;
type RestoreResult = { restored: number; discarded: number; reason?: "missing" | "version" | "parse" };

/** A snapshot contains only durable cache content, never recheck timestamps. */
export class RunnerRegistrationScanCacheSnapshot {
  private readonly path: string;
  private lastWritten = JSON.stringify({ version: VERSION, entries: [] });

  constructor(stateDirectory: string, private readonly cache: RunnerRegistrationScanCache) {
    this.path = join(stateDirectory, ".registration-scan-cache.json");
  }

  async restore(): Promise<RestoreResult> {
    this.cache.restore([]);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      return { restored: 0, discarded: 0, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "parse" };
    }
    if (!isRecord(data) || data.version !== VERSION) {
      return { restored: 0, discarded: 0, reason: "version" };
    }
    if (!Array.isArray(data.entries)) return { restored: 0, discarded: 0, reason: "parse" };
    const entries = data.entries.filter(isSnapshotEntry);
    this.cache.restore(entries);
    this.lastWritten = JSON.stringify(data);
    return { restored: entries.length, discarded: data.entries.length - entries.length };
  }

  async persist(): Promise<boolean> {
    const content = JSON.stringify({ version: VERSION, entries: this.cache.snapshot() });
    if (content === this.lastWritten) return false;
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, this.path);
    this.lastWritten = content;
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function isSnapshotEntry(value: unknown): value is RunnerRegistrationSnapshotEntry {
  if (!isRecord(value) || typeof value.directory !== "string" || !isAbsolute(value.directory)
    || typeof value.fingerprint !== "string" || !isRecord(value.registration)) return false;
  const registration = value.registration;
  if (!RunnerChildConfigSchema.safeParse(registration.config).success
    || (registration.pid !== null && typeof registration.pid !== "number")
    || typeof registration.pidAlive !== "boolean" || typeof registration.registeredAtMs !== "number"
    || !(registration.bootstrap === null || isRecord(registration.bootstrap))
    || !(registration.lifecycle === null || (isRecord(registration.lifecycle)
      && typeof registration.lifecycle.execution_state === "string"))
    || !optionalString(registration.retiredAt) || !optionalString(registration.registrationId)
    || !optionalString(registration.pidStartIdentity)) return false;
  return canCache(registration as unknown as RunnerRegistration);
}
