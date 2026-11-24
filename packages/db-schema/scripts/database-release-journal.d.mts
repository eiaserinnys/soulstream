import type postgres from "postgres";
import type { DatabaseReleaseAuthority, SystemctlShow } from "./database-release-installer.mjs";
export const DATABASE_RELEASE_SCHEMA_VERSION: "soulstream.database-release.v1";
export interface DatabaseInventory {
  relation_count: number;
  routine_count: number;
  type_count: number;
  ledger_count: number;
  object_count?: number;
  object_fingerprint?: string;
  objects?: Array<{ kind: string; identity: string }>;
}
export interface DatabasePlan {
  state: string;
  ledger: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
  bootstrap: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
}
export interface DatabaseReleaseJournal {
  [key: string]: unknown;
  operation: string;
  status: string;
  request_id: string;
  revision: number;
  history: unknown[];
  affected_services: string[];
  additive_only?: boolean;
}
export function plannedSchemaWorkCount(journal: DatabaseReleaseJournal): number;
export function requiresQuiescence(journal: DatabaseReleaseJournal): boolean;
export function databaseReleaseJournalPath(env?: NodeJS.ProcessEnv): string;
export function databaseReleaseJournalArchivePath(path: string, journal: DatabaseReleaseJournal): string;
export function journalIdentity(env: NodeJS.ProcessEnv, operation: string, authority?: DatabaseReleaseAuthority): Record<string, unknown>;
export function readDatabaseReleaseJournal(path: string): Promise<DatabaseReleaseJournal>;
export function writeDatabaseReleaseJournal<T extends Record<string, unknown>>(path: string, journal: T, options?: { fileSystem?: { open: (path: string, flags: string, mode?: number) => Promise<{ writeFile: (data: string) => Promise<unknown>; sync: () => Promise<void>; close: () => Promise<void> }>; rename: (source: string, destination: string) => Promise<void>; unlink?: (path: string) => Promise<void> }; platform?: NodeJS.Platform }): Promise<T>;
export function createDatabaseReleaseJournal(options: { env: NodeJS.ProcessEnv; operation: string; plan: DatabasePlan; inventory: DatabaseInventory; now?: () => Date; authority?: DatabaseReleaseAuthority }): Promise<DatabaseReleaseJournal>;
export function transitionDatabaseReleaseJournal(path: string, status: string, options?: { phase?: string; details?: Record<string, unknown>; error?: unknown; now?: () => Date; expectedRevision?: number; expectedStatuses?: string[] }): Promise<DatabaseReleaseJournal>;
export function classifyLedgerReconciliation(journal: Record<string, unknown>, plan: Pick<DatabasePlan, "ledger">, inventory: DatabaseInventory): "full" | "none" | "ambiguous";
export function inspectUserObjectInventory(sql: postgres.Sql): Promise<Required<DatabaseInventory>>;
export function fingerprintInventory(inventory: DatabaseInventory): string;
export function assertDatabaseReleaseIdentity<T extends DatabaseReleaseJournal>(journal: T, identity: Record<string, unknown>): T;
export function assertDatabaseReleaseApplyGate(options: { env: NodeJS.ProcessEnv; operation: string; plan: DatabasePlan; inventory: DatabaseInventory; authority?: DatabaseReleaseAuthority; systemctlShow?: SystemctlShow }): Promise<DatabaseReleaseJournal>;
export function releaseJournalDirectory(env?: NodeJS.ProcessEnv): string;
