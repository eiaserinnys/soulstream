import { compileRecurringSchedule, normalizeRecurringTimezone } from "./cron.js";
import { RecurringJobError, type RecurringJob, type RecurringJobActor } from "./types.js";

export function assertRecurringJobActor(actor: RecurringJobActor): void {
  if (!actor || !actor.ownerEmail.trim() || !actor.actorId.trim()) {
    throw new RecurringJobError("FORBIDDEN", "A verified recurring-job actor is required", 403);
  }
}

export function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} is required`);
  return value.trim();
}

export function normalizedModelPreset(value: string | null): string | null {
  if (value === null) return null;
  return requiredText(value, "model_preset");
}

export function normalizedContainer(value: RecurringJob["container"]): RecurringJob["container"] {
  if (!value || (value.kind !== "folder" && value.kind !== "task")) {
    throw validation("container.kind is invalid");
  }
  return { kind: value.kind, id: requiredText(value.id, "container.id") };
}

export function validation(message: string): RecurringJobError {
  return new RecurringJobError("VALIDATION", message, 422);
}

export function compileSchedule(input: {
  timezone: string;
  scheduleExpressions: readonly string[];
}): ReturnType<typeof compileRecurringSchedule> {
  try {
    return compileRecurringSchedule(input);
  } catch (error) {
    throw validation(error instanceof Error ? error.message : "invalid recurring schedule");
  }
}

const OFFSET_ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function onceTimezone(value: string): string {
  try {
    return normalizeRecurringTimezone(value);
  } catch (error) {
    throw validation(error instanceof Error ? error.message : "invalid timezone");
  }
}

export function parseRunAt(value: string): Date {
  const input = requiredText(value, "run_at");
  const match = OFFSET_ISO_8601.exec(input);
  if (!match) {
    throw validation("run_at must be an ISO 8601 timestamp with an explicit offset");
  }

  const [year, month, day, hour, minute, second = 0] = match.slice(1, 7).map(Number);
  const daysInMonth = [31, isLeapYear(year!) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const dayLimit = daysInMonth[month! - 1];
  if (
    !dayLimit || day! < 1 || day! > dayLimit || hour! > 23 || minute! > 59 || second! > 59
  ) {
    throw validation("run_at must be a valid ISO 8601 timestamp with an explicit offset");
  }

  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime())) {
    throw validation("run_at must be a valid ISO 8601 timestamp with an explicit offset");
  }
  return parsed;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function versionConflict(job: RecurringJob): RecurringJobError {
  return new RecurringJobError("VERSION_CONFLICT", "Recurring job changed. Reload before saving.", 409, job);
}
