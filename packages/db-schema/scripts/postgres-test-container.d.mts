export const SOULSTREAM_TEST_HARNESS_LABEL: "soulstream-test-harness=1";
export const DEFAULT_STALE_CONTAINER_AGE_MS: number;

export interface PostgresTestContainerOptions {
  user: string;
  password: string;
  database: string;
  staleAfterMs?: number;
}

export interface PostgresTestContainerLease {
  containerId: string;
  port: string;
  reapedContainerIds: string[];
  stop(): void;
}

export function startPostgresTestContainer(
  options: PostgresTestContainerOptions,
): PostgresTestContainerLease;

export function reapStalePostgresTestContainers(options?: {
  staleAfterMs?: number;
  nowMs?: number;
}): string[];

export function stopPostgresTestContainer(containerId: string): void;
