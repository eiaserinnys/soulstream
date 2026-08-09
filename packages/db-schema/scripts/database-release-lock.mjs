import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 20;
const MIN_RECLAIM_RELEASE_WINDOW_MS = 500;

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function processStartIdentity(pid, platform = process.platform) {
  if (platform !== "linux") return null;
  try {
    const statText = await readFile(`/proc/${pid}/stat`, "utf8");
    const afterName = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
    return afterName[19] ?? null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function ownerIsStale(owner, platform = process.platform) {
  if (!processExists(Number(owner?.pid))) return true;
  const currentStart = await processStartIdentity(Number(owner?.pid), platform);
  if (currentStart !== null && owner?.process_start_identity !== currentStart) return true;
  // Platforms without a process-start identity fail closed while the PID is live.
  // Reclaiming by age would let a long-running release lose its lease on Windows.
  return false;
}

function reclaimClaimPath(lockPath) {
  return `${lockPath}.reclaim-claim`;
}

function ownerMetadata(now = () => new Date()) {
  const timestamp = now().toISOString();
  return {
    nonce: randomUUID(),
    pid: process.pid,
    process_start_identity: null,
    created_at: timestamp,
    heartbeat_at: timestamp,
  };
}

async function completeOwnerMetadata(owner, platform) {
  return {
    ...owner,
    process_start_identity: await processStartIdentity(owner.pid, platform),
  };
}

function activationConflict(error, platform) {
  return error?.code === "EEXIST" || error?.code === "ENOTEMPTY"
    || (platform === "win32" && error?.code === "EPERM");
}

async function prepareGeneration(path, owner) {
  await mkdir(path, { mode: 0o700 });
  await writeFile(resolve(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function inspectGeneration(path, platform) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
  let raw = null;
  let owner = null;
  try {
    raw = await readFile(resolve(path, "owner.json"), "utf8");
    owner = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const fallback = [
    metadata.dev, metadata.ino, metadata.birthtimeMs, metadata.mtimeMs, raw ?? "missing",
  ].join(":");
  const identity = typeof owner?.nonce === "string" && owner.nonce
    ? `nonce:${owner.nonce}`
    : `filesystem:${createHash("sha256").update(fallback).digest("hex")}`;
  return {
    exists: true,
    identity,
    owner,
    stale: owner === null || await ownerIsStale(owner, platform),
  };
}

function safeGenerationToken(identity) {
  return createHash("sha256").update(identity).digest("hex");
}

async function reclaimOrphanClaim(claimPath, observed, platform) {
  const current = await inspectGeneration(claimPath, platform);
  if (!current.exists || current.identity !== observed.identity || !current.stale) return false;
  const tombstone = `${claimPath}.reclaimed-${safeGenerationToken(observed.identity)}`;
  try {
    await rename(claimPath, tombstone);
    // The deterministic tombstone is intentionally retained. A contender that
    // observed the retired generation can never rename a newer live claim onto
    // the same destination, closing the claim-level ABA race.
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || activationConflict(error, platform)) return false;
    throw error;
  }
}

async function acquireReclaimClaim(lockPath, deadline, platform) {
  const claimPath = reclaimClaimPath(lockPath);
  for (;;) {
    const owner = await completeOwnerMetadata(ownerMetadata(), platform);
    const candidate = `${claimPath}.candidate-${owner.nonce}`;
    try {
      await prepareGeneration(candidate, owner);
      try {
        await rename(candidate, claimPath);
        return { claimPath, owner };
      } catch (error) {
        if (!activationConflict(error, platform)) throw error;
      }
      const observed = await inspectGeneration(claimPath, platform);
      if (observed.exists && observed.stale) {
        await reclaimOrphanClaim(claimPath, observed, platform);
      }
    } catch (error) {
      if (!activationConflict(error, platform)) throw error;
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
    if (Date.now() >= deadline) {
      throw new Error(`RELEASE_LEASE_CONFLICT: timed out acquiring ${lockPath}`);
    }
    await sleep(POLL_MS);
  }
}

async function releaseReclaimClaim(claim, platform, deadline) {
  const retired = `${claim.claimPath}.released-${claim.owner.nonce}`;
  for (;;) {
    const current = await inspectGeneration(claim.claimPath, platform);
    if (!current.exists) return;
    if (current.owner?.nonce !== claim.owner.nonce) {
      throw new Error("RELEASE_LEASE_CONFLICT: reclaim claim ownership changed");
    }
    try {
      await rename(claim.claimPath, retired);
      // A Windows contender may still have owner.json open while the claim owner
      // retires the directory. Once the rename succeeds the active claim is gone;
      // cleanup is best effort and cannot affect a newer claim generation.
      await rm(retired, {
        recursive: true,
        force: true,
        maxRetries: platform === "win32" ? 10 : 0,
        retryDelay: POLL_MS,
      }).catch((error) => {
        if (platform !== "win32" || error?.code !== "EPERM") throw error;
      });
      return;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (platform !== "win32" || error?.code !== "EPERM") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `RELEASE_LEASE_CONFLICT: timed out releasing reclaim claim ${claim.claimPath}`,
        );
      }
      await sleep(POLL_MS);
    }
  }
}

async function withReclaimClaim(
  lockPath,
  deadline,
  platform,
  callback,
  onReclaimClaimAcquired,
) {
  const claim = await acquireReclaimClaim(lockPath, deadline, platform);
  await onReclaimClaimAcquired?.(claim);
  try {
    return await callback();
  } finally {
    await releaseReclaimClaim(
      claim,
      platform,
      Math.max(deadline, Date.now() + MIN_RECLAIM_RELEASE_WINDOW_MS),
    );
  }
}

async function quarantineLockGeneration(lockPath) {
  const quarantine = `${lockPath}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
    return quarantine;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function databaseReleaseJournalLockPath(journalPath) {
  return `${journalPath}.lock`;
}

export function databaseReleasePhaseLockPath(env) {
  const backupDirectory = env.HANIEL_BACKUP_DIR?.trim();
  const repo = env.HANIEL_DEPLOY_REPO?.trim();
  if (!backupDirectory) throw new Error("HANIEL_BACKUP_DIR is required for database release");
  if (!repo) throw new Error("HANIEL_DEPLOY_REPO is required for database release");
  const safeRepo = repo.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(dirname(resolve(backupDirectory)), `.database-release-${safeRepo}.lock`);
}

export async function acquireDatabaseReleaseLease(
  lockPath,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    platform = process.platform,
    now = () => new Date(),
    onReclaimClaimAcquired,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const owner = await completeOwnerMetadata(ownerMetadata(now), platform);
  owner.acquired_at = owner.created_at;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`RELEASE_LEASE_CONFLICT: timed out acquiring ${lockPath}`);
    }
    let quarantine = null;
    let acquired;
    try {
      acquired = await withReclaimClaim(lockPath, deadline, platform, async () => {
        const observed = await inspectGeneration(lockPath, platform);
        if (observed.exists) {
          if (!observed.stale) return false;
          const current = await inspectGeneration(lockPath, platform);
          if (!current.exists || current.identity !== observed.identity || !current.stale) {
            return false;
          }
          quarantine = await quarantineLockGeneration(lockPath);
        }
        const candidate = `${lockPath}.candidate-${owner.nonce}`;
        try {
          await prepareGeneration(candidate, owner);
          await rename(candidate, lockPath);
          return true;
        } finally {
          await rm(candidate, { recursive: true, force: true });
        }
      }, onReclaimClaimAcquired);
    } finally {
      if (quarantine) await rm(quarantine, { recursive: true, force: true });
    }
    if (acquired) return { lockPath, owner };
    if (Date.now() >= deadline) {
      throw new Error(`RELEASE_LEASE_CONFLICT: timed out acquiring ${lockPath}`);
    }
    await sleep(POLL_MS);
  }
}

export async function releaseDatabaseReleaseLease(lease) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let quarantine = null;
  await withReclaimClaim(lease.lockPath, deadline, process.platform, async () => {
    let current;
    try {
      current = JSON.parse(await readFile(resolve(lease.lockPath, "owner.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (current.nonce !== lease.owner.nonce) {
      throw new Error("RELEASE_LEASE_CONFLICT: lock ownership changed before release");
    }
    quarantine = await quarantineLockGeneration(lease.lockPath);
  });
  if (quarantine) await rm(quarantine, { recursive: true, force: true });
}

export async function withDatabaseReleaseLease(lockPath, callback, options = {}) {
  const lease = await acquireDatabaseReleaseLease(lockPath, options);
  try {
    return await callback(lease);
  } finally {
    await releaseDatabaseReleaseLease(lease);
  }
}

export function assertDatabaseReleaseLease(lease, lockPath) {
  if (!lease || lease.lockPath !== lockPath || !lease.owner?.nonce) {
    throw new Error("RELEASE_LEASE_REQUIRED: database release lease is required");
  }
  return lease;
}
