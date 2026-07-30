export const BLOCKED_CHILD_PROCESS_API_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TURN_SUMMARY_OPENAI_KEY",
] as const;

export type BlockedChildProcessApiKey =
  typeof BLOCKED_CHILD_PROCESS_API_KEYS[number];

export function sanitizeChildProcessEnv(
  input: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const blocked = new Set<string>(
    BLOCKED_CHILD_PROCESS_API_KEYS,
  );
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || blocked.has(key)) continue;
    output[key] = value;
  }
  return output;
}

export function findBlockedChildProcessEnvKeys(
  input: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): BlockedChildProcessApiKey[] {
  return BLOCKED_CHILD_PROCESS_API_KEYS.filter(
    (key) => input[key] !== undefined,
  );
}

export function warnForBlockedChildProcessEnvKeys(
  input: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void,
): void {
  const keys = findBlockedChildProcessEnvKeys(input);
  if (keys.length === 0) return;
  warn(
    `Turn-summary child processes will omit billing-switch API keys: ${keys.join(", ")}`,
  );
}
