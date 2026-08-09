import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for database release`);
  return value;
}

export function readStringList(env, name) {
  const raw = required(env, name);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(parsed) || parsed.length === 0
    || !parsed.every((value) => typeof value === "string" && value.trim())) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  const normalized = [...new Set(parsed.map((value) => value.trim()))].sort();
  if (normalized.length !== parsed.length) throw new Error(`${name} contains duplicates`);
  return normalized;
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function canonicalReceipt(receipt) {
  return {
    request_id: receipt.request_id,
    repo: receipt.repo,
    target_head: receipt.target_head,
    owner_instance: receipt.owner_instance,
    quiescence_nonce: receipt.quiescence_nonce,
    stopped_services: [...(receipt.stopped_services ?? [])].sort(),
    already_stopped_services: [...(receipt.already_stopped_services ?? [])].sort(),
    quiesced_services: [...(receipt.quiesced_services ?? [])].sort(),
  };
}

export function receiptDigest(receipt) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalReceipt(receipt)))
    .digest("hex");
}

function assertReceipt(receipt, env, expectedServices) {
  const stopped = receipt?.stopped_services;
  const alreadyStopped = receipt?.already_stopped_services;
  const quiesced = receipt?.quiesced_services;
  const stringList = (value) => Array.isArray(value)
    && value.every((item) => typeof item === "string" && item);
  if (
    receipt?.request_id !== required(env, "HANIEL_REQUEST_ID")
    || receipt?.repo !== required(env, "HANIEL_DEPLOY_REPO")
    || receipt?.target_head !== required(env, "HANIEL_TARGET_HEAD")
    || typeof receipt?.owner_instance !== "string" || !receipt.owner_instance
    || typeof receipt?.quiescence_nonce !== "string" || !receipt.quiescence_nonce
    || !stringList(stopped) || !stringList(alreadyStopped) || !stringList(quiesced)
  ) {
    throw new Error("QUIESCENCE_REQUIRED: receipt identity is incomplete");
  }
  const stoppedSet = new Set(stopped);
  const alreadySet = new Set(alreadyStopped);
  const quiescedSet = new Set(quiesced);
  if (
    stoppedSet.size !== stopped.length
    || alreadySet.size !== alreadyStopped.length
    || quiescedSet.size !== quiesced.length
    || [...stoppedSet].some((service) => alreadySet.has(service))
    || !sameStrings([...stoppedSet, ...alreadySet], expectedServices)
    || !sameStrings(quiesced, expectedServices)
  ) {
    throw new Error("QUIESCENCE_REQUIRED: writer service set differs");
  }
  return canonicalReceipt(receipt);
}

const PHASE_STATES = {
  backup: new Set(["backing_up"]),
  verify_backup: new Set(["backing_up"]),
  apply: new Set(["migrating"]),
  verify: new Set(["verifying"]),
  recovery: new Set(["recovering"]),
  subphase: new Set(["migrating"]),
};

export async function readHanielReleaseEvidence({ env, journal, phase }) {
  const hanielPath = required(env, "HANIEL_DEPLOYMENT_JOURNAL");
  const expectedServices = journal.writer_services ?? readStringList(
    env,
    "HANIEL_DATABASE_WRITER_SERVICES",
  );
  let haniel;
  try {
    haniel = JSON.parse(await readFile(hanielPath, "utf8"));
  } catch (error) {
    throw new Error(`QUIESCENCE_REQUIRED: Haniel release evidence is unavailable: ${error.message}`);
  }
  const expectedState = PHASE_STATES[phase];
  const identityMismatch = (
    haniel.request_id !== journal.request_id
    || haniel.repo !== journal.repo
    || haniel.target_head !== journal.target_head
    || haniel.operation !== journal.operation
    || haniel.expected_operation !== journal.operation
    || haniel.manifest_digest !== journal.manifest_checksum
    || resolve(haniel.database_journal_path ?? "")
      !== resolve(required(env, "HANIEL_BACKUP_DIR"), "database-release.json")
    || !expectedState?.has(haniel.state)
  );
  if (identityMismatch) {
    throw new Error("QUIESCENCE_REQUIRED: Haniel journal does not match database release intent");
  }
  if (journal.operation === "fresh_install") {
    return {
      receipt: null,
      receipt_digest: null,
      haniel,
      owner_instance: null,
      quiescence_nonce: null,
      writer_services: expectedServices,
    };
  }
  const receiptPath = required(env, "HANIEL_QUIESCENCE_RECEIPT");
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`QUIESCENCE_REQUIRED: receipt is unavailable: ${error.message}`);
  }
  const canonical = assertReceipt(receipt, env, expectedServices);
  const embedded = assertReceipt(haniel.quiescence_receipt, env, expectedServices);
  if (receiptDigest(embedded) !== receiptDigest(canonical)) {
    throw new Error("QUIESCENCE_REQUIRED: Haniel receipt link differs");
  }
  return {
    receipt: canonical,
    receipt_digest: receiptDigest(canonical),
    haniel,
    owner_instance: canonical.owner_instance,
    quiescence_nonce: canonical.quiescence_nonce,
    writer_services: expectedServices,
  };
}
