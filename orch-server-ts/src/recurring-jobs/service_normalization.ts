import { compileRecurringSchedule, nextRecurringOccurrences } from "./cron.js";
import { normalizeEventTrigger } from "./event_trigger.js";
import {
  compileSchedule,
  normalizedModelPreset,
  onceTimezone,
  parseRunAt,
  positiveLateRunWindowSeconds,
  requiredText,
  validation,
} from "./input_validation.js";
import type {
  RecurringJob,
  RecurringJobActor,
  RecurringJobCreateInput,
  RecurringJobEventTrigger,
  RecurringJobUpdateInput,
} from "./types.js";

export type ValidateRecurringJobTarget = (input: {
  readonly actor: RecurringJobActor;
  readonly target: Pick<RecurringJob, "nodeId" | "agentId" | "modelPreset" | "folderId">;
  readonly requireAvailableTarget: boolean;
  readonly purpose: "settings" | "execution";
}) => Promise<void>;

export type NormalizedRecurringJobCreate = {
  name: string;
  prompt: string;
  scheduleKind: RecurringJob["scheduleKind"];
  scheduleExpressions: readonly string[];
  runAt: string | null;
  eventTrigger: RecurringJobEventTrigger | null;
  timezone: string;
  nodeId: string;
  agentId: string;
  modelPreset: string | null;
  folderId: string;
  lateRunWindowSeconds: number;
  schedule: ReturnType<typeof compileRecurringSchedule> | null;
};

export async function normalizeRecurringJobCreate(
  actor: RecurringJobActor,
  input: RecurringJobCreateInput,
  getNow: () => Date,
  validateTarget?: ValidateRecurringJobTarget,
): Promise<NormalizedRecurringJobCreate> {
  const hasScheduleExpressions = input.scheduleExpressions !== undefined;
  const hasRunAt = input.runAt !== undefined;
  const hasEventTrigger = input.eventTrigger !== undefined;
  if ([hasScheduleExpressions, hasRunAt, hasEventTrigger].filter(Boolean).length !== 1) {
    throw validation("provide exactly one of schedule_expressions, run_at, or event_trigger");
  }
  const now = getNow();
  const nodeId = requiredText(input.nodeId, "node_id");
  const schedule = hasScheduleExpressions ? compileSchedule({
    timezone: input.timezone,
    scheduleExpressions: input.scheduleExpressions!,
  }) : null;
  const runAt = hasRunAt ? requiredText(input.runAt!, "run_at") : null;
  if (runAt !== null && parseRunAt(runAt).getTime() <= now.getTime()) {
    throw validation("run_at must be in the future");
  }
  const eventTrigger = hasEventTrigger
    ? normalizeEventTrigger(input.eventTrigger!, nodeId)
    : null;
  const normalized = {
    name: requiredText(input.name, "name"),
    prompt: requiredText(input.prompt, "prompt"),
    scheduleKind: hasRunAt ? "once" as const : hasEventTrigger ? "event" as const : "recurring" as const,
    scheduleExpressions: schedule?.scheduleExpressions ?? [],
    runAt,
    eventTrigger,
    timezone: schedule?.timezone ?? onceTimezone(requiredText(input.timezone, "timezone")),
    nodeId,
    agentId: requiredText(input.agentId, "agent_id"),
    modelPreset: normalizedModelPreset(input.modelPreset),

    folderId: requiredText(input.folderId, "folder_id"),
    lateRunWindowSeconds: positiveLateRunWindowSeconds(input.lateRunWindowSeconds ?? 1_800),
    schedule,
  };
  await validateTarget?.({ actor, target: normalized, requireAvailableTarget: true, purpose: "settings" });
  return normalized;
}

export async function mergeRecurringJobUpdate(
  actor: RecurringJobActor,
  current: RecurringJob,
  input: RecurringJobUpdateInput,
  now: Date,
  validateTarget?: ValidateRecurringJobTarget,
): Promise<RecurringJob> {
  if (current.scheduleKind === "event") {
    return await mergeEventJobUpdate(actor, current, input, now, validateTarget);
  }
  if (input.runAt !== undefined) throw validation("run_at cannot be changed for a recurring job");
  if (input.eventTrigger !== undefined) throw validation("event_trigger cannot be changed for a recurring job");
  const scheduleExpressions = input.scheduleExpressions ?? current.scheduleExpressions;
  const timezone = input.timezone ?? current.timezone;
  const schedule = compileSchedule({ timezone, scheduleExpressions });
  const enabled = input.enabled ?? current.enabled;
  const modelPreset = input.modelPreset === undefined
    ? current.modelPreset
    : normalizedModelPreset(input.modelPreset);
  const recomputeNextRun =
    (input.enabled === true && !current.enabled) ||
    input.timezone !== undefined ||
    input.scheduleExpressions !== undefined;
  const nextOccurrence = nextRecurringOccurrences(schedule, now, 1)[0];
  if (!nextOccurrence) throw new Error("compiled schedule did not produce a future occurrence");
  const nextRunAt = !enabled
    ? null
    : recomputeNextRun
      ? nextOccurrence.toISOString()
      : current.nextRunAt;
  const candidate = {
    ...current,
    name: input.name === undefined ? current.name : requiredText(input.name, "name"),
    prompt: input.prompt === undefined ? current.prompt : requiredText(input.prompt, "prompt"),
    scheduleExpressions: schedule.scheduleExpressions,
    timezone: schedule.timezone,
    nodeId: input.nodeId === undefined ? current.nodeId : requiredText(input.nodeId, "node_id"),
    agentId: input.agentId === undefined ? current.agentId : requiredText(input.agentId, "agent_id"),
    modelPreset,

    folderId: input.folderId === undefined ? current.folderId : requiredText(input.folderId, "folder_id"),
    lateRunWindowSeconds: positiveLateRunWindowSeconds(
      input.lateRunWindowSeconds === undefined ? current.lateRunWindowSeconds : input.lateRunWindowSeconds,
    ),
    enabled,
    nextRunAt,
    updatedAt: now.toISOString(),
  } satisfies RecurringJob;
  await validateTarget?.({
    actor,
    target: candidate,
    requireAvailableTarget: candidate.nodeId !== current.nodeId ||
      candidate.agentId !== current.agentId ||
      candidate.modelPreset !== current.modelPreset,
    purpose: "settings",
  });
  return candidate;
}

async function mergeEventJobUpdate(
  actor: RecurringJobActor,
  current: RecurringJob,
  input: RecurringJobUpdateInput,
  now: Date,
  validateTarget?: ValidateRecurringJobTarget,
): Promise<RecurringJob> {
  if (input.scheduleExpressions !== undefined) {
    throw validation("schedule_expressions cannot be changed for an event job");
  }
  if (input.runAt !== undefined) throw validation("run_at cannot be changed for an event job");
  const nodeId = input.nodeId === undefined ? current.nodeId : requiredText(input.nodeId, "node_id");
  const eventTrigger = input.eventTrigger === undefined
    ? current.eventTrigger ?? null
    : normalizeEventTrigger(input.eventTrigger, nodeId);
  if (eventTrigger === null) throw new Error(`event job ${current.jobId} has no event_trigger`);
  const candidate = {
    ...current,
    name: input.name === undefined ? current.name : requiredText(input.name, "name"),
    prompt: input.prompt === undefined ? current.prompt : requiredText(input.prompt, "prompt"),
    timezone: input.timezone === undefined
      ? current.timezone
      : onceTimezone(requiredText(input.timezone, "timezone")),
    scheduleKind: "event" as const,
    scheduleExpressions: [],
    runAt: null,
    eventTrigger,
    nodeId,
    agentId: input.agentId === undefined ? current.agentId : requiredText(input.agentId, "agent_id"),
    modelPreset: input.modelPreset === undefined
      ? current.modelPreset
      : normalizedModelPreset(input.modelPreset),

    folderId: input.folderId === undefined ? current.folderId : requiredText(input.folderId, "folder_id"),
    lateRunWindowSeconds: positiveLateRunWindowSeconds(
      input.lateRunWindowSeconds === undefined ? current.lateRunWindowSeconds : input.lateRunWindowSeconds,
    ),
    enabled: input.enabled ?? current.enabled,
    nextRunAt: null,
    updatedAt: now.toISOString(),
  } satisfies RecurringJob;
  await validateTarget?.({
    actor,
    target: candidate,
    requireAvailableTarget: candidate.nodeId !== current.nodeId ||
      candidate.agentId !== current.agentId ||
      candidate.modelPreset !== current.modelPreset,
    purpose: "settings",
  });
  return candidate;
}
