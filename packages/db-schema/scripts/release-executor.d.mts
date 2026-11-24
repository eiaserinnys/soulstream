export interface DatabaseReleaseSubphaseEnvironment extends NodeJS.ProcessEnv {
  HANIEL_BACKUP_DIR: string;
  HANIEL_DATABASE_SUBPHASE_TOKEN: string;
  HANIEL_DEPLOY_REPO: string;
}

export interface DatabaseReleaseSubphaseGateOptions {
  env?: DatabaseReleaseSubphaseEnvironment | NodeJS.ProcessEnv;
  subphase: string;
}

export interface DatabaseReleaseJournal {
  operation: "fresh_install" | "upgrade";
  status: string;
  current_subphase?: string | null;
  active_subphase_token_digest?: string | null;
}

export function assertDatabaseReleaseSubphaseGate(
  options: DatabaseReleaseSubphaseGateOptions,
): Promise<DatabaseReleaseJournal>;

export function databaseReleaseFailure(
  error: unknown,
  env: NodeJS.ProcessEnv,
  phase: string,
): Record<string, unknown>;

export function formatDatabaseReleaseError(
  error: unknown,
  env?: NodeJS.ProcessEnv,
): string;

export function sanitizeDatabaseReleaseResult<T>(
  value: T,
  env?: NodeJS.ProcessEnv,
): T;

export function serializeDatabaseReleaseResult(
  value: unknown,
  env?: NodeJS.ProcessEnv,
): string;
export { DATABASE_RELEASE_SCHEMA_VERSION, databaseReleaseJournalPath, inspectUserObjectInventory, readDatabaseReleaseJournal } from "./database-release-journal.mjs";
export function classifyDatabaseOperation(inventory: import("./database-release-journal.mjs").DatabaseInventory): "fresh_install" | "upgrade";
export interface DatabaseReleaseOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sql?: import("postgres").Sql;
  inventoryRead?: () => Promise<import("./database-release-journal.mjs").DatabaseInventory>;
  planRead?: () => Promise<import("./database-release-journal.mjs").DatabasePlan>;
  migrationRun?: (mode: string, options: { env: NodeJS.ProcessEnv; sql?: import("postgres").Sql | null; journalPath?: string; authority?: import("./database-release-installer.mjs").DatabaseReleaseAuthority; systemctlShow?: import("./database-release-installer.mjs").SystemctlShow }) => Promise<unknown>;
  subphase?: string;
  childCommand?: string[];
  manifestMigration?: unknown;
  /** Chosen by the CLI from the release files. Defaults to "haniel". */
  authority?: import("./database-release-installer.mjs").DatabaseReleaseAuthority;
  /** Test seam for the installer platform fence. Defaults to process.platform. */
  platform?: NodeJS.Platform | string;
  /** Test seam for the installer live unit check. Defaults to the absolute systemctl. */
  systemctlShow?: import("./database-release-installer.mjs").SystemctlShow;
  afterApplyCommit?: () => void | Promise<void>;
  subphaseRun?: (command: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => void | Promise<void>;
  timeoutMs?: number;
}
export interface DatabaseReleaseResult {
  [key: string]: unknown;
  journal_path: string | null;
}
export function runDatabaseRelease(command: string, options?: DatabaseReleaseOptions): Promise<DatabaseReleaseResult>;
export function planDatabaseRelease(options: DatabaseReleaseOptions & { expectedOperation: string }): Promise<DatabaseReleaseResult>;
export function executeDatabaseReleasePhase(phase: "preflight", options?: DatabaseReleaseOptions): Promise<DatabaseReleaseResult & { journal_path: string }>;
export function executeDatabaseReleasePhase(phase: string, options?: DatabaseReleaseOptions): Promise<DatabaseReleaseResult>;
