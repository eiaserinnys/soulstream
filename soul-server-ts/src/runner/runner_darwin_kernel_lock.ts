import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadNodeSqlite } from "./node_sqlite.js";
import { isRunnerSqliteBusyError } from "./runner_sqlite_connection.js";

const DARWIN_LOCK_NAME_PREFIX = "soulstream-runner-lock-";

/**
 * A process-lifetime lock for Darwin, backed by an OS-owned SQLite EXCLUSIVE
 * transaction.
 *
 * macOS has no abstract Unix socket namespace, and a filesystem socket cannot
 * carry ownership: a killed holder leaves the socket behind, and probing then
 * unlinking it lets two contenders delete each other's fresh socket. A SQLite
 * rollback-journal EXCLUSIVE transaction has both properties the runner lock
 * needs: it excludes every other connection, and the kernel releases it when
 * the holding process dies. The database file is only a stable name; no table,
 * row, lease, pid probe, or timeout participates in the ownership decision.
 */
export function darwinKernelLockPath(path: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("the Darwin runner kernel lock requires a numeric user id");
  }
  const digest = createHash("sha256").update(canonicalLockPath(path)).digest("hex");
  return `/tmp/${DARWIN_LOCK_NAME_PREFIX}${uid}-${digest}.sqlite`;
}

export function tryAcquireDarwinKernelLock(path: string): { release(): void } | null {
  const { DatabaseSync } = loadNodeSqlite();
  const database = new DatabaseSync(darwinKernelLockPath(path));
  try {
    database.exec("PRAGMA busy_timeout=0");
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (isRunnerSqliteBusyError(error)) return null;
    throw error;
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

export function isDarwinKernelLockHeld(path: string): boolean {
  const lockPath = darwinKernelLockPath(path);
  if (!existsSync(lockPath)) return false;
  const { DatabaseSync } = loadNodeSqlite();
  const database = new DatabaseSync(lockPath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=0");
    database.prepare("PRAGMA schema_version").get();
    return false;
  } catch (error) {
    if (isRunnerSqliteBusyError(error)) return true;
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Resolves the nearest existing ancestor to its real path and reattaches the
 * not-yet-created suffix. The lock name must be stable for symlinked state
 * directories such as /tmp and /private/tmp without inventing a file; only a
 * missing ancestor is walked up, while access errors stay visible.
 */
function canonicalLockPath(path: string): string {
  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return missingSegments.length === 0 ? real : join(real, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}
