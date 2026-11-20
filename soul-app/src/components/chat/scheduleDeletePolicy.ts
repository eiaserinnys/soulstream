import type { ClaudeRuntimeScheduleStatus } from '../../../../packages/soul-ui/src/lib/claude-runtime-projection';

const NON_DELETABLE_STATUSES = new Set<ClaudeRuntimeScheduleStatus>([
  'completed',
  'cancelled',
  'failed',
]);

export function canDeleteClaudeRuntimeSchedule(status: ClaudeRuntimeScheduleStatus): boolean {
  return !NON_DELETABLE_STATUSES.has(status);
}
