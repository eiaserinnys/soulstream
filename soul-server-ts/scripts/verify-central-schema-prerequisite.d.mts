export function verifyCentralSchemaPrerequisite(options: {
  upstreamUrl: string;
  schemaGeneration: string;
  fetchImpl?: (url: URL, init?: RequestInit) => Promise<Response>;
  sleepImpl?: (delayMs: number) => Promise<void>;
  nowImpl?: () => number;
  attemptTimeoutMs?: number;
  retryIntervalMs?: number;
  totalBudgetMs?: number;
}): Promise<{ migration_id: string; checksum: string }>;
