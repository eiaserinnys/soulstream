import {
  applyClaudeRuntimeEvent,
  type ClaudeRuntimeView,
} from '../../../packages/soul-ui/src/lib/claude-runtime-projection';

export function applyClaudeRuntimePayload(
  current: ClaudeRuntimeView | undefined,
  type: string,
  data: unknown,
): ClaudeRuntimeView | undefined {
  if (typeof data !== 'object' || data === null) return current;
  return applyClaudeRuntimeEvent(
    current ?? null,
    { ...(data as Record<string, unknown>), type },
  ) ?? undefined;
}
