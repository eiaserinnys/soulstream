import {
  defaultRecurringSchedule as defaultSharedRecurringSchedule,
  recurringScheduleExpressions as sharedRecurringScheduleExpressions,
  recurringScheduleFromExpressions as sharedRecurringScheduleFromExpressions,
  type RecurringScheduleDraft as SharedRecurringScheduleDraft,
  type RecurringScheduleMode as SharedRecurringScheduleMode,
} from "@seosoyoung/soul-ui/lib/recurring-schedule";

export type RecurringScheduleMode = "once" | SharedRecurringScheduleMode;

export type RecurringScheduleDraft = Omit<SharedRecurringScheduleDraft, "mode"> & {
  mode: RecurringScheduleMode;
  runAtLocal: string;
};

export function defaultRecurringSchedule(): RecurringScheduleDraft {
  return { ...defaultSharedRecurringSchedule(), runAtLocal: nextRunAtLocal() };
}

export function recurringScheduleFromExpressions(
  expressions: readonly string[],
): RecurringScheduleDraft {
  return { ...sharedRecurringScheduleFromExpressions(expressions), runAtLocal: nextRunAtLocal() };
}

export function recurringScheduleExpressions(schedule: RecurringScheduleDraft): string[] {
  if (schedule.mode === "once") return [];
  return sharedRecurringScheduleExpressions({ ...schedule, mode: schedule.mode });
}

function nextRunAtLocal(): string {
  const runAt = new Date();
  runAt.setMinutes(0, 0, 0);
  runAt.setHours(runAt.getHours() + 1);
  return formatLocalDateTime(runAt);
}

function formatLocalDateTime(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
