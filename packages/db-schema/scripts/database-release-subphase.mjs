import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { readHanielReleaseEvidence } from "./database-release-evidence.mjs";
import {
  assertDatabaseReleaseIdentity,
  databaseReleaseJournalPath,
  journalIdentity,
  readDatabaseReleaseJournal,
  transitionDatabaseReleaseJournal,
} from "./database-release-journal.mjs";
import { formatDatabaseReleaseError } from "./database-release-result.mjs";

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}

function transition(path, current, status, options) {
  return transitionDatabaseReleaseJournal(path, status, {
    ...options,
    expectedRevision: current.revision,
    expectedStatuses: [current.status],
  });
}

export async function assertDatabaseReleaseSubphaseGate({
  env = process.env,
  subphase,
}) {
  const path = databaseReleaseJournalPath(env);
  const journal = await readDatabaseReleaseJournal(path);
  assertDatabaseReleaseIdentity(journal, journalIdentity(env, journal.operation));
  const token = env.HANIEL_DATABASE_SUBPHASE_TOKEN?.trim();
  if (
    journal.status !== "subphase_started"
    || journal.current_subphase !== subphase
    || !token
    || tokenDigest(token) !== journal.active_subphase_token_digest
  ) {
    throw new Error("JOURNAL_GATE_FAILED: active database release subphase is required");
  }
  await readHanielReleaseEvidence({ env, journal, phase: "subphase" });
  return journal;
}

function runChild(command, env, timeoutMs) {
  if (!Array.isArray(command) || command.length === 0
    || !command.every((item) => typeof item === "string" && item)) {
    throw new Error("SUBPHASE_FAILED: child command is required");
  }
  const result = spawnSync(command[0], command.slice(1), {
    env,
    encoding: "utf8",
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = formatDatabaseReleaseError(result.stderr ?? "", env);
    const stdout = formatDatabaseReleaseError(result.stdout ?? "", env);
    throw new Error(
      `SUBPHASE_FAILED: child exited ${result.status ?? "without status"}; `
      + `stderr=${stderr.slice(-8192)} stdout=${stdout.slice(-4096)}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export async function executeDatabaseReleaseSubphase({
  env,
  subphase,
  command,
  timeoutMs = 300_000,
  runner = runChild,
}) {
  const path = databaseReleaseJournalPath(env);
  let journal = await readDatabaseReleaseJournal(path);
  assertDatabaseReleaseIdentity(journal, journalIdentity(env, journal.operation));
  if (journal.status === "verified" || journal.status === "applied") return journal;
  if (!journal.required_subphases.includes(subphase)) {
    throw new Error(`JOURNAL_GATE_FAILED: unknown required subphase ${subphase}`);
  }
  if (journal.completed_subphases.includes(subphase)) return journal;
  if (!new Set(["sql_applied", "subphase_started", "subphase_complete"]).has(journal.status)) {
    throw new Error("JOURNAL_GATE_FAILED: SQL apply must complete before a subphase");
  }
  if (journal.status === "subphase_started" && journal.current_subphase !== subphase) {
    throw new Error("JOURNAL_GATE_FAILED: another database release subphase is incomplete");
  }
  const token = randomUUID();
  journal = await transition(path, journal, "subphase_started", {
    phase: `subphase:${subphase}`,
    details: {
      current_subphase: subphase,
      active_subphase_token_digest: tokenDigest(token),
      subphase_attempt_id: randomUUID(),
    },
  });
  const childEnv = { ...env, HANIEL_DATABASE_SUBPHASE_TOKEN: token };
  try {
    await runner(command, childEnv, timeoutMs);
  } catch (error) {
    await transition(path, journal, "subphase_started", {
      phase: `subphase:${subphase}`,
      details: { active_subphase_token_digest: null },
      error: { code: "SUBPHASE_FAILED" },
    });
    throw error;
  }
  journal = await transition(path, journal, "subphase_complete", {
    phase: `subphase:${subphase}`,
    details: {
      current_subphase: null,
      active_subphase_token_digest: null,
      completed_subphases: [...new Set([...journal.completed_subphases, subphase])].sort(),
    },
  });
  if (journal.required_subphases.every((item) => journal.completed_subphases.includes(item))) {
    journal = await transition(path, journal, "applied", {
      phase: "apply",
      details: { apply_committed_at: new Date().toISOString() },
    });
  }
  return journal;
}
