import { compileRecurringSchedule } from "./cron.js";
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

export function versionConflict(job: RecurringJob): RecurringJobError {
  return new RecurringJobError("VERSION_CONFLICT", "Recurring job changed. Reload before saving.", 409, job);
}
