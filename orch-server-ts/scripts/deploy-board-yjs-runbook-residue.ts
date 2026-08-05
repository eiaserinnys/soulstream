import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runBoardYjsRunbookDeployment,
  type BoardYjsRunbookDeployMode,
} from "../src/board-yjs/board_yjs_runbook_deploy.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const orchRoot = resolve(repositoryRoot, "orch-server-ts");
const approvalPath = resolve(
  orchRoot,
  "scripts/ydoc-runbook-collision-approvals.json",
);
const tsxCli = resolve(orchRoot, "node_modules/tsx/dist/cli.mjs");
const migrationScript = resolve(
  orchRoot,
  "scripts/migrate-board-yjs-runbook-residue.ts",
);
const verificationScript = resolve(
  orchRoot,
  "scripts/verify-board-yjs-runbook-residue.ts",
);

const mode = readMode(process.argv);
loadDeploymentEnvironment();
const nodeId = requiredEnv("SOULSTREAM_NODE_ID");
const approvedCollisionHashes = await readApprovedCollisionHashes(approvalPath);

try {
  await runBoardYjsRunbookDeployment({
    nodeId,
    mode,
    approvedCollisionHashCount: approvedCollisionHashes.length,
    applySqlMigrations: async () => runNode([
      resolve(repositoryRoot, "packages/db-schema/scripts/migrate.mjs"),
      "apply",
    ]),
    reportResidue: async () => runNode([tsxCli, migrationScript, "--summary"]),
    applyResidueMigration: async () => runNode([
      tsxCli,
      migrationScript,
      "--apply",
      "--quiesced",
      "--orch-health-url=http://127.0.0.1:5200/api/health",
      `--approved-collision-hashes=${approvalPath}`,
    ]),
    verifyResidue: async () => runNode([tsxCli, verificationScript]),
    audit: async (status) => writeAudit({ status }),
  });
} catch (error) {
  await writeAudit({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

function readMode(argv: readonly string[]): BoardYjsRunbookDeployMode {
  const modes = [
    argv.includes("--migrate") ? "migrate" : null,
    argv.includes("--verify") ? "verify" : null,
  ].filter((value): value is BoardYjsRunbookDeployMode => value !== null);
  if (modes.length !== 1) throw new Error("exactly one of --migrate or --verify is required");
  return modes[0]!;
}

function loadDeploymentEnvironment(): void {
  const serviceCwd = process.env.HANIEL_SERVICE_CWD?.trim() || repositoryRoot;
  process.loadEnvFile(resolve(serviceCwd, ".env.soul-server-ts"));
}

async function readApprovedCollisionHashes(path: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
  )) {
    throw new Error("collision approval file must be an array of SHA-256 strings");
  }
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("collision approval file contains duplicate hashes");
  }
  return parsed;
}

function runNode(args: string[]): void {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`deployment child command exited with ${result.status ?? "no status"}`);
  }
}

async function writeAudit(input: { status: string; error?: string }): Promise<void> {
  const record = {
    event: "board_yjs_runbook_migration",
    status: input.status,
    mode,
    nodeId,
    approvedCollisionHashCount: approvedCollisionHashes.length,
    releaseId: process.env.HANIEL_RELEASE_ID ?? null,
    targetHead: process.env.HANIEL_TARGET_HEAD ?? null,
    occurredAt: new Date().toISOString(),
    ...(input.error ? { error: input.error } : {}),
  };
  const line = JSON.stringify(record);
  process.stdout.write(`${line}\n`);
  const backupDirectory = process.env.HANIEL_BACKUP_DIR?.trim();
  if (!backupDirectory) return;
  await mkdir(backupDirectory, { recursive: true });
  await appendFile(
    resolve(backupDirectory, "board-yjs-runbook-migration.jsonl"),
    `${line}\n`,
    "utf8",
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
