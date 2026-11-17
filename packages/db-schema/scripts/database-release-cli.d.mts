export function applyManifestContract(manifestPath: string | null, databaseContractPath: string | null, env: Record<string, string>): Promise<unknown>;
export function runDatabaseReleaseCli(
  runner: (command: string, options: { env: Record<string, string>; manifestMigration: unknown; subphase?: string | null; childCommand?: string[] }) => Promise<unknown>,
  options?: { argv?: string[]; env?: Record<string, string>; stdout?: (line: string) => void; stderr?: (line: string) => void },
): Promise<number>;
