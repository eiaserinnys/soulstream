import { canDeleteClaudeRuntimeSchedule } from '../scheduleDeletePolicy';

describe('canDeleteClaudeRuntimeSchedule', () => {
  it('allows direct deletion for orphaned schedules', () => {
    expect(canDeleteClaudeRuntimeSchedule('orphaned')).toBe(true);
  });

  it('keeps completed/cancelled/failed schedules non-deletable', () => {
    expect(canDeleteClaudeRuntimeSchedule('completed')).toBe(false);
    expect(canDeleteClaudeRuntimeSchedule('cancelled')).toBe(false);
    expect(canDeleteClaudeRuntimeSchedule('failed')).toBe(false);
  });
});
