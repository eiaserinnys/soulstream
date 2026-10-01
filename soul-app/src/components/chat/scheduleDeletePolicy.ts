import type { ClaudeRuntimeScheduleStatus } from '../../api/types';

const NON_DELETABLE_STATUSES = new Set<ClaudeRuntimeScheduleStatus>([
  'completed',
  'cancelled',
  'failed',
]);

export function canDeleteClaudeRuntimeSchedule(status: ClaudeRuntimeScheduleStatus): boolean {
  return !NON_DELETABLE_STATUSES.has(status);
}
