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

export function sanitizeDatabaseReleaseResult<T>(
  value: T,
  env?: NodeJS.ProcessEnv,
): T;

export function serializeDatabaseReleaseResult(
  value: unknown,
  env?: NodeJS.ProcessEnv,
): string;
