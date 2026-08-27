#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAB_REPO = "/home/eias/services/soulstream-lab/repo";
const LAB_STATE = "/home/eias/services/soulstream-lab/state";
const TASK_EXECUTOR = "soul-server-ts/src/task/task_executor.ts";
const CLEANUP_BLOCK = `      if (runner && task.executionOwnership === undefined) {
        try {
          if (proof && runner.dispatcher.rollbackExecutionIdentity) {
            await runner.dispatcher.rollbackExecutionIdentity(proof);
          } else {
            await runner.dispatcher.close();
          }
        } finally {
          releaseTaskRunner(task, runner);
        }
      }`;
const MUTATED_BLOCK = `      if (runner && task.executionOwnership === undefined) {
        releaseTaskRunner(task, runner);
      }`;

export function applyCleanupRemovedMutation(source) {
  if (source.split(CLEANUP_BLOCK).length !== 2) {
    throw new Error("cleanup rollback block must occur exactly once");
  }
  return source.replace(CLEANUP_BLOCK, MUTATED_BLOCK);
}

export function restoreCleanupRemovedMutation(mutated, original) {
  if (applyCleanupRemovedMutation(original) !== mutated) {
    throw new Error("cleanup mutation source changed before restore");
  }
  return original;
}

async function applyMutation(repo, backupPath) {
  assertLabPaths(repo, backupPath);
  const sourcePath = join(repo, TASK_EXECUTOR);
  const original = await readFile(sourcePath, "utf8");
  const mutated = applyCleanupRemovedMutation(original);
  await writeFile(
    backupPath,
    `${JSON.stringify({ sourcePath, original, mutated })}\n`,
    { mode: 0o600 },
  );
  await writeFile(sourcePath, mutated);
  process.stdout.write("H2 cleanup-removed product mutation applied\n");
}

async function restoreMutation(repo, backupPath) {
  assertLabPaths(repo, backupPath);
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  const sourcePath = join(repo, TASK_EXECUTOR);
  if (backup.sourcePath !== sourcePath) throw new Error("H2 mutation backup path mismatch");
  const current = await readFile(sourcePath, "utf8");
  const restored = restoreCleanupRemovedMutation(current, backup.original);
  await writeFile(sourcePath, restored);
  await unlink(backupPath);
  process.stdout.write("H2 cleanup-removed product mutation restored\n");
}

function assertLabPaths(repo, backupPath) {
  if (resolve(repo) !== LAB_REPO) throw new Error(`unsafe H2 mutation repo: ${repo}`);
  const resolvedBackup = resolve(backupPath);
  if (!resolvedBackup.startsWith(`${LAB_STATE}/`)) {
    throw new Error(`unsafe H2 mutation backup: ${backupPath}`);
  }
}

async function main() {
  const [command, repo, backupPath] = process.argv.slice(2);
  if (command === "apply") return await applyMutation(repo, backupPath);
  if (command === "restore") return await restoreMutation(repo, backupPath);
  throw new Error("usage: fault-h2-product-mutation.mjs <apply|restore> <repo> <backup>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
