import { compileRecurringSchedule, nextRecurringOccurrences } from "./cron.js";
import {
  compileSchedule,
  normalizedContainer,
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
  RecurringJobUpdateInput,
} from "./types.js";

export type ValidateRecurringJobTarget = (input: {
  readonly actor: RecurringJobActor;
  readonly target: Pick<RecurringJob, "nodeId" | "agentId" | "modelPreset" | "container" | "folderId">;
  readonly requireAvailableTarget: boolean;
}) => Promise<void>;

export type NormalizedRecurringJobCreate = {
  name: string;
  prompt: string;
  scheduleKind: RecurringJob["scheduleKind"];
  scheduleExpressions: readonly string[];
  runAt: string | null;
  timezone: string;
  nodeId: string;
  agentId: string;
  modelPreset: string | null;
  container: RecurringJob["container"];
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
  if (hasScheduleExpressions === hasRunAt) {
    throw validation("provide exactly one of schedule_expressions or run_at");
  }
  const now = getNow();
  const schedule = hasRunAt ? null : compileSchedule({
    timezone: input.timezone,
    scheduleExpressions: input.scheduleExpressions!,
  });
  const runAt = hasRunAt ? requiredText(input.runAt!, "run_at") : null;
  if (runAt !== null && parseRunAt(runAt).getTime() <= now.getTime()) {
    throw validation("run_at must be in the future");
  }
  const normalized = {
    name: requiredText(input.name, "name"),
    prompt: requiredText(input.prompt, "prompt"),
    scheduleKind: hasRunAt ? "once" as const : "recurring" as const,
    scheduleExpressions: schedule?.scheduleExpressions ?? [],
    runAt,
    timezone: schedule?.timezone ?? onceTimezone(requiredText(input.timezone, "timezone")),
    nodeId: requiredText(input.nodeId, "node_id"),
    agentId: requiredText(input.agentId, "agent_id"),
    modelPreset: normalizedModelPreset(input.modelPreset),
    container: normalizedContainer(input.container),
    folderId: requiredText(input.folderId, "folder_id"),
    lateRunWindowSeconds: positiveLateRunWindowSeconds(input.lateRunWindowSeconds ?? 1_800),
    schedule,
  };
  await validateTarget?.({ actor, target: normalized, requireAvailableTarget: true });
  return normalized;
}

export async function mergeRecurringJobUpdate(
  actor: RecurringJobActor,
  current: RecurringJob,
  input: RecurringJobUpdateInput,
  now: Date,
  validateTarget?: ValidateRecurringJobTarget,
): Promise<RecurringJob> {
  if (input.runAt !== undefined) throw validation("run_at cannot be changed for a recurring job");
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
    container: input.container === undefined ? current.container : normalizedContainer(input.container),
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
  });
  return candidate;
}
