import type postgres from "postgres";
import type { Migration, MigrationLedgerRow, SchemaShape, SchemaState } from "./migration-contract.mjs";
export function inspectSchemaShape(sql: postgres.Sql): Promise<SchemaShape>;
export function readMigrationLedger(sql: postgres.Sql): Promise<MigrationLedgerRow[]>;
export function readMigrationPlan(sql: postgres.Sql, migrations?: Migration[] | null): Promise<{ state: SchemaState; bootstrap: Migration[]; pending: Migration[]; shape: SchemaShape; ledger: MigrationLedgerRow[] }>;
export function runMigrations(mode: string, options?: { env?: NodeJS.ProcessEnv; cwd?: string; sql?: postgres.Sql | null }): Promise<Record<string, unknown>>;
export function formatMigrationError(error: unknown, env?: NodeJS.ProcessEnv): string;
