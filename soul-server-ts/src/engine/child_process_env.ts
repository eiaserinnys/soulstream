import type { Logger } from "pino";

export const BLOCKED_CHILD_PROCESS_API_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TURN_SUMMARY_OPENAI_KEY",
] as const;

export function sanitizeChildProcessEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const blocked = new Set<string>(BLOCKED_CHILD_PROCESS_API_KEYS);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || blocked.has(key)) continue;
    output[key] = value;
  }
  return output;
}

export function findBlockedChildProcessEnvKeys(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  return BLOCKED_CHILD_PROCESS_API_KEYS.filter(
    (key) => input[key] !== undefined,
  );
}

export function logBlockedChildProcessEnvKeys(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
  logger: Pick<Logger, "warn">,
): void {
  const blockedKeys = findBlockedChildProcessEnvKeys(input);
  if (blockedKeys.length === 0) return;
  logger.warn(
    { blockedKeys },
    "Blocked billing-switch API keys will be removed from child processes",
  );
}
