import { requiredText, validation } from "./input_validation.js";
import { makeRecurringRun } from "./run_lifecycle.js";
import type {
  RecurringJob,
  RecurringJobEventTrigger,
  RecurringJobEventTriggerInput,
  RecurringJobRepository,
  RecurringJobRun,
  RecurringNodePresence,
  RecurringSessionLauncher,
} from "./types.js";

export const NODE_CONNECTED_EVENT_TYPE = "node_connected";
export const EVENT_SETTLE_DEFAULT_SECONDS = 180;
export const EVENT_SETTLE_MAX_SECONDS = 3_600;
export const EVENT_COOLDOWN_DEFAULT_SECONDS = 3_600;
export const EVENT_COOLDOWN_MAX_SECONDS = 604_800;
/** A shorter disconnect keeps the same connected episode across a restart. */
export const NODE_PRESENCE_EPISODE_GAP_MS = 600_000;
export const EVENT_JOB_LIMIT = 100;

/** Fills the server-owned defaults; the trigger node falls back to the execution node. */
export function normalizeEventTrigger(
  input: RecurringJobEventTriggerInput,
  executionNodeId: string,
): RecurringJobEventTrigger {
  if (input.type !== NODE_CONNECTED_EVENT_TYPE) {
    throw validation(`event_trigger.type must be ${NODE_CONNECTED_EVENT_TYPE}`);
  }
  return {
    type: NODE_CONNECTED_EVENT_TYPE,
    nodeId: input.nodeId === undefined
      ? executionNodeId
      : requiredText(input.nodeId as string, "event_trigger.node_id"),
    settleSeconds: boundedInteger(
      input.settleSeconds,
      EVENT_SETTLE_DEFAULT_SECONDS,
      0,
      EVENT_SETTLE_MAX_SECONDS,
      "event_trigger.settle_seconds",
    ),
    cooldownSeconds: boundedInteger(
      input.cooldownSeconds,
      EVENT_COOLDOWN_DEFAULT_SECONDS,
      0,
      EVENT_COOLDOWN_MAX_SECONDS,
      "event_trigger.cooldown_seconds",
    ),
    repeat: optionalBoolean(input.repeat, "event_trigger.repeat") ?? false,
  };
}

/** A job that deletes itself once its session is confirmed running. */
export function isSingleRunJob(job: RecurringJob): boolean {
  return job.scheduleKind === "once" ||
    (job.scheduleKind === "event" && job.eventTrigger != null && !job.eventTrigger.repeat);
}

/**
 * The episode continues while the new connection starts within the gap of the
 * last observation. Otherwise the registry's connect instant starts a new one.
 */
export function resolveNodePresence(input: {
  readonly nodeId: string;
  readonly current: RecurringNodePresence | null;
  readonly connectedAtMs: number;
  readonly now: Date;
}): RecurringNodePresence {
  const lastSeenMs = input.current === null ? Number.NaN : Date.parse(input.current.lastSeenAt);
  const sameEpisode = input.current !== null && Number.isFinite(lastSeenMs) &&
    input.connectedAtMs - lastSeenMs <= NODE_PRESENCE_EPISODE_GAP_MS;
  return {
    nodeId: input.nodeId,
    episodeStartedAt: sameEpisode && input.current !== null
      ? input.current.episodeStartedAt
      : new Date(input.connectedAtMs).toISOString(),
    lastSeenAt: input.now.toISOString(),
  };
}

/** True only when settle, once-per-episode, and cooldown all allow a firing. */
export function nodeConnectedEventFires(input: {
  readonly trigger: RecurringJobEventTrigger;
  readonly lastFiredAt: string | null;
  readonly episodeStartedAt: string;
  readonly connectedAtMs: number;
  readonly now: Date;
}): boolean {
  const nowMs = input.now.getTime();
  if (nowMs - input.connectedAtMs < input.trigger.settleSeconds * 1_000) return false;
  const lastFiredMs = input.lastFiredAt === null ? null : Date.parse(input.lastFiredAt);
  if (lastFiredMs === null) return true;
  if (!Number.isFinite(lastFiredMs)) return false;
  if (lastFiredMs >= Date.parse(input.episodeStartedAt)) return false;
  return nowMs - lastFiredMs >= input.trigger.cooldownSeconds * 1_000;
}

export type NodeConnectedTriggerContext = {
  readonly repository: RecurringJobRepository;
  readonly launcher?: RecurringSessionLauncher;
  readonly now: Date;
  readonly newId: () => string;
  readonly dispatch: (job: RecurringJob, run: RecurringJobRun) => Promise<RecurringJobRun>;
};

/** One scheduler tick of node-connected event jobs. */
export async function processNodeConnectedTriggers(
  context: NodeConnectedTriggerContext,
): Promise<RecurringJobRun[]> {
  const launcher = context.launcher;
  if (!launcher) return [];
  const jobs = await context.repository.listEventJobs(EVENT_JOB_LIMIT);
  const fired: RecurringJobRun[] = [];
  const observed = new Map<string, ObservedNode | null>();
  for (const job of jobs) {
    const trigger = job.eventTrigger;
    if (job.scheduleKind !== "event" || trigger == null) continue;
    if (!observed.has(trigger.nodeId)) {
      observed.set(trigger.nodeId, await observeNode(
        context.repository,
        launcher,
        trigger.nodeId,
        context.now,
      ));
    }
    const node = observed.get(trigger.nodeId);
    if (!node) continue;
    if (!nodeConnectedEventFires({
      trigger,
      lastFiredAt: job.eventLastFiredAt ?? null,
      episodeStartedAt: node.presence.episodeStartedAt,
      connectedAtMs: node.settleAnchorMs,
      now: context.now,
    })) continue;
    // An active run makes this tick a silent no-op: no run row, no stamp.
    if (await context.repository.findActiveRun(job.jobId)) continue;
    const waiting = !launcher.isNodeConnected(job.nodeId);
    const run = makeRecurringRun(job, {
      trigger: "event",
      scheduledFor: context.now,
      state: waiting ? "waiting_for_node" : "queued",
      now: context.now,
      ...(waiting ? {
        reason: {
          code: "NODE_OFFLINE",
          message: `Execution node ${job.nodeId} is offline; this event run waits for it.`,
        },
      } : {}),
    }, context.newId);
    const reserved = await context.repository.reserveEventRun({
      job,
      run,
      now: context.now,
    });
    if (!reserved || reserved.run.state !== "queued") continue;
    fired.push(await context.dispatch(job, reserved.run));
  }
  return fired;
}

type ObservedNode = {
  readonly presence: RecurringNodePresence;
  /** Settle time is measured from the registry connection when it is known. */
  readonly settleAnchorMs: number;
};

async function observeNode(
  repository: RecurringJobRepository,
  launcher: RecurringSessionLauncher,
  nodeId: string,
  now: Date,
): Promise<ObservedNode | null> {
  if (!launcher.isNodeConnected(nodeId)) return null;
  const registryConnectedAtMs = launcher.nodeConnectedAtMs?.(nodeId);
  const connectedAtMs = registryConnectedAtMs !== undefined && Number.isFinite(registryConnectedAtMs)
    ? registryConnectedAtMs
    : now.getTime();
  const presence = resolveNodePresence({
    nodeId,
    current: await repository.getNodePresence(nodeId),
    connectedAtMs,
    now,
  });
  await repository.upsertNodePresence(presence);
  return {
    presence,
    settleAnchorMs: registryConnectedAtMs !== undefined && Number.isFinite(registryConnectedAtMs)
      ? registryConnectedAtMs
      : Date.parse(presence.episodeStartedAt),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validation(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw validation(`${name} must be boolean`);
  return value;
}
