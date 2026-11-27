export const POSTGRES_TEST_GLOBS: string[];
export const DOCKER_ONLY_GLOB: string;
export const FULL_SLICE_GLOB: string;
export const TEST_SCHEMA_PATTERN: string;
export function isPostgresTestFile(path: string): boolean;
export function dockerAvailable(): boolean;
export function requirePostgresBackendInCI(path: string, env?: NodeJS.ProcessEnv, probeDocker?: () => boolean): void;
export function decidePostgresTests(env?: NodeJS.ProcessEnv, probeDocker?: () => boolean): {
  isCI: boolean;
  backendAvailable: boolean;
  excludePostgres: boolean;
  excludeFullSlice: boolean;
};
export function postgresVitestOptions(env?: NodeJS.ProcessEnv, probeDocker?: () => boolean): {
  exclude: string[];
  passWithNoTests: boolean;
};
