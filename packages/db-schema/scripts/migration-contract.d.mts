export interface Migration {
  id: string;
  sha256: string;
  ordinal: number;
  path: string;
  sql: string;
}
export interface MigrationLedgerRow {
  migration_id: string;
  ordinal: number | string;
  checksum: string;
}
export type SchemaShape = Record<string, string | boolean | null | undefined>;
export type SchemaState = "empty" | "current" | "pre_cards" | "pre_folder_unification" | "legacy_pre_041" | "legacy_post_041";
export const LEDGER_TABLE: string;
export const MIGRATION_LOCK_NAMESPACE: number;
export const MIGRATION_LOCK_ID: number;
export const migrationDirectory: string;
export const migrationManifestPath: string;
export const canonicalSchemaPath: string;
export function deploymentEnvironmentPath(env?: NodeJS.ProcessEnv, cwd?: string): string;
export function releaseServiceEnvironmentPath(env?: NodeJS.ProcessEnv, cwd?: string): string;
export function sha256(value: string | Uint8Array): string;
export function migrationSha256(sql: string): string;
export function readDatabaseUrl(env?: NodeJS.ProcessEnv): string;
export function readReleaseId(env?: NodeJS.ProcessEnv, options?: { required?: boolean }): string | null;
export function loadMigrationManifest(): Promise<Migration[]>;
export function validateLedger<T extends Pick<Migration, "id" | "ordinal" | "sha256">>(migrations: T[], rows: MigrationLedgerRow[]): T[];
export function classifySchemaState(shape: SchemaShape): SchemaState;
export function buildMigrationPlan<T extends Pick<Migration, "id" | "ordinal" | "sha256">>(migrations: T[], ledger: MigrationLedgerRow[], shape: SchemaShape): { state: SchemaState; bootstrap: T[]; pending: T[] };
