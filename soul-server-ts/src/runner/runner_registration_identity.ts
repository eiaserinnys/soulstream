import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renameWithTransientRetry } from "../atomic_file_rename.js";
import { processStartIdentitiesMatch } from "./runner_process_lock.js";
import { openRunnerSqliteReadOnlyDatabase } from "./runner_sqlite_connection.js";
import { runnerRowToBootstrap } from "./sqlite_event_outbox_records.js";
import type { RunnerEventOutboxRow } from "./sqlite_event_outbox_schema.js";

const RUNNER_IDENTITY_FILE = "runner-identity.json";

export interface RunnerRegistrationIdentity {
  schemaVersion: 1;
  registrationId: string;
  sessionId: string;
  codeSha: string;
  pid: number | null;
  startIdentity: string | null;
}

export interface RecoveredRunnerIdentity {
  sessionId: string;
  codeSha?: string;
}

export function runnerRegistrationIdentityPath(sessionDirectory: string): string {
  return join(sessionDirectory, RUNNER_IDENTITY_FILE);
}

export function pendingRunnerRegistrationIdentity(
  sessionId: string,
  codeSha: string,
): RunnerRegistrationIdentity {
  if (!sessionId || !codeSha) throw new Error("runner registration identity requires session and release");
  return {
    schemaVersion: 1,
    registrationId: randomUUID(),
    sessionId,
    codeSha,
    pid: null,
    startIdentity: null,
  };
}

export async function writeRunnerRegistrationIdentity(
  sessionDirectory: string,
  identity: RunnerRegistrationIdentity,
): Promise<void> {
  validateRunnerRegistrationIdentity(identity);
  const path = runnerRegistrationIdentityPath(sessionDirectory);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(identity)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await renameWithTransientRetry(temporaryPath, path);
}

export async function readRunnerRegistrationIdentity(
  sessionDirectory: string,
): Promise<RunnerRegistrationIdentity | null> {
  try {
    return validateRunnerRegistrationIdentity(
      JSON.parse(await readFile(runnerRegistrationIdentityPath(sessionDirectory), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function completeRunnerRegistrationIdentityFromChild(
  sessionDirectory: string,
  input: {
    sessionId: string;
    codeSha: string;
    pid: number;
    startIdentity: string;
  },
): Promise<RunnerRegistrationIdentity> {
  const current = await readRunnerRegistrationIdentity(sessionDirectory);
  if (!current || current.sessionId !== input.sessionId || current.codeSha !== input.codeSha) {
    throw new Error(`runner registration changed before child startup: ${input.sessionId}`);
  }
  if (current.pid !== null) {
    if (
      current.pid !== input.pid
      || current.startIdentity === null
      || !processStartIdentitiesMatch(current.startIdentity, input.startIdentity)
    ) {
      throw new Error(`runner registration already belongs to another process: ${input.sessionId}`);
    }
    return current;
  }
  const completed = { ...current, pid: input.pid, startIdentity: input.startIdentity };
  await writeRunnerRegistrationIdentity(sessionDirectory, completed);
  return completed;
}

export async function invalidateRunnerRegistrationIdentity(
  sessionDirectory: string,
  expectedRegistrationId: string | null,
): Promise<void> {
  const current = await readRunnerRegistrationIdentity(sessionDirectory);
  if (!current) return;
  if (expectedRegistrationId === null || current.registrationId !== expectedRegistrationId) {
    throw new Error(`runner registration was superseded before invalidation: ${current.sessionId}`);
  }
  await writeRunnerRegistrationIdentity(sessionDirectory, {
    ...current,
    pid: null,
    startIdentity: null,
  });
}

export async function waitForChildRunnerRegistrationIdentity(
  sessionDirectory: string,
  pending: RunnerRegistrationIdentity,
  pid: number,
  deps: {
    isPidAlive(pid: number): boolean;
    now(): number;
    delay(ms: number): Promise<void>;
  },
): Promise<RunnerRegistrationIdentity | null> {
  const deadline = deps.now() + 10_000;
  while (deps.isPidAlive(pid) && deps.now() < deadline) {
    const current = await readRunnerRegistrationIdentity(sessionDirectory);
    if (
      !current
      || current.registrationId !== pending.registrationId
      || current.sessionId !== pending.sessionId
      || current.codeSha !== pending.codeSha
    ) {
      throw new Error(`runner registration changed during child startup: ${pending.sessionId}`);
    }
    if (current.pid !== null) {
      if (current.pid !== pid || current.startIdentity === null) {
        throw new Error(`runner child published an invalid process identity: ${pending.sessionId}`);
      }
      return current;
    }
    await deps.delay(25);
  }
  return null;
}

export async function recoverRunnerDirectoryIdentity(
  sessionDirectory: string,
): Promise<RecoveredRunnerIdentity | null> {
  try {
    const sidecar = await readRunnerRegistrationIdentity(sessionDirectory);
    if (sidecar) return { sessionId: sidecar.sessionId, codeSha: sidecar.codeSha };
  } catch {
    // A corrupt sidecar is not trusted. SQLite remains an independent identity source.
  }
  try {
    return readRunnerSqliteIdentity(join(sessionDirectory, "runner.sqlite"));
  } catch {
    return null;
  }
}

function readRunnerSqliteIdentity(databasePath: string): RecoveredRunnerIdentity | null {
  const database = openRunnerSqliteReadOnlyDatabase(databasePath);
  try {
    const bootstrapRow = database.prepare(`
      SELECT *
      FROM runner_event_outbox
      WHERE record_kind = 'bootstrap'
    `).get() as unknown as RunnerEventOutboxRow | undefined;
    if (bootstrapRow) {
      const bootstrap = runnerRowToBootstrap(bootstrapRow);
      return {
        sessionId: bootstrap.session_id,
        codeSha: bootstrap.payload.code_sha,
      };
    }
    const prebootstrap = database.prepare(`
      SELECT session_id
      FROM runner_prebootstrap_lifecycle
      WHERE singleton = 1
    `).get() as { session_id: unknown } | undefined;
    return prebootstrap
      ? { sessionId: requiredString(prebootstrap.session_id, "runner SQLite session id") }
      : null;
  } finally {
    database.close();
  }
}

function validateRunnerRegistrationIdentity(value: unknown): RunnerRegistrationIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("runner registration identity must be an object");
  }
  const candidate = value as Partial<RunnerRegistrationIdentity>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.registrationId !== "string"
    || !candidate.registrationId
    || typeof candidate.sessionId !== "string"
    || !candidate.sessionId
    || typeof candidate.codeSha !== "string"
    || !candidate.codeSha
    || (candidate.pid !== null && (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0))
    || (candidate.startIdentity !== null
      && (typeof candidate.startIdentity !== "string" || !candidate.startIdentity))
    || ((candidate.pid === null) !== (candidate.startIdentity === null))
  ) {
    throw new Error("runner registration identity is invalid");
  }
  return candidate as RunnerRegistrationIdentity;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is invalid`);
  return value;
}
