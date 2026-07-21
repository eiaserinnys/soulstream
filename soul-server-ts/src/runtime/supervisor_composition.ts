import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { Env } from "../config.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB, SupervisorEventRow } from "../db/session_db.js";
import type { EngineFactory } from "../task/task_executor.js";
import { TaskExecutor } from "../task/task_executor.js";
import { TaskCompletionNotifier } from "../task/completion_notifier.js";
import { ClaudeRuntimeTaskFollowupController } from "../task/claude_runtime_task_followup.js";
import type { StartExecutionCallback, TaskManager } from "../task/task_manager.js";
import { extractCallerInfoFromMetadata } from "../task/task_metadata.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { ScheduleDispatcher } from "../schedule/schedule_dispatcher.js";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { SupervisorHandoverExecutor } from "../supervisor/handover_executor.js";
import {
  buildSupervisorSnapshotWakeText,
  buildSupervisorWakeText,
  type SupervisorWakeSessionSummary,
  wakeSessionSummaryFromRow,
} from "../supervisor/wake_text.js";
import { buildSupervisorSnapshotSessionSummaries } from "../supervisor/wake_snapshot.js";
import { shouldDispatchSupervisorWakeCandidate } from "../supervisor/wake_source_filter.js";
import {
  SupervisorWakeRouter,
  SupervisorWakeScheduler,
  type SupervisorWakeEvent,
} from "../supervisor/wake_router.js";
import { detectMissingSupervisors } from "../supervisor/watchdog.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface SupervisorCompositionParams {
  env: Env;
  db: SessionDB;
  logger: Logger;
  agentRegistry: AgentRegistry;
  taskManager: TaskManager;
  engineFactory: EngineFactory;
  contextBuilder: ExecutionContextBuilder;
  persistence: EventPersistence;
  broadcaster: SessionBroadcaster;
  scheduleService: SoulstreamScheduleService;
  orchProxyConfig: OrchProxyConfig;
}

export interface SupervisorComposition {
  taskExecutor: TaskExecutor;
  onResume: StartExecutionCallback;
  scheduleDispatcher: ScheduleDispatcher;
  supervisorWakeScheduler?: SupervisorWakeScheduler;
  supervisorWatchdogInterval?: NodeJS.Timeout;
}

/** Owns TaskExecutor's supervisor, completion, schedule, and resume wiring. */
export function composeSupervisorRuntime(
  params: SupervisorCompositionParams,
): SupervisorComposition {
  const {
    env,
    db,
    logger,
    agentRegistry,
    taskManager,
    engineFactory,
    contextBuilder,
    persistence,
    broadcaster,
    scheduleService,
    orchProxyConfig,
  } = params;
  let taskExecutor: TaskExecutor;
  const onResume: StartExecutionCallback = (task) => {
    if (!task.profileId) {
      throw new Error(`Cannot auto-resume ${task.agentSessionId}: task is missing profileId`);
    }
    const agent = agentRegistry.get(task.profileId);
    if (!agent) {
      throw new Error(
        `Cannot auto-resume ${task.agentSessionId}: unknown agent profile ${task.profileId}`,
      );
    }
    taskExecutor.startExecution(task, agent);
  };

  const completionNotifier = new TaskCompletionNotifier(
    env.SOULSTREAM_NODE_ID,
    taskManager,
    agentRegistry,
    onResume,
    logger,
    orchProxyConfig,
    undefined,
    db,
  );
  const claudeRuntimeTaskFollowup = new ClaudeRuntimeTaskFollowupController({
    taskManager,
    onResume,
    logger,
  });
  const supervisorWakeRouter = new SupervisorWakeRouter(
    {
      getCursor: (supervisorId) => db.getSupervisorConsumerCursor(supervisorId),
      getHeadOffset: () => db.getSupervisorEventHeadOffset(),
      readEventsAfter: async (afterOffset, limit) =>
        (await db.readSupervisorEventsAfter(afterOffset, limit)).map((event) => ({
          offset: event.offset,
          sourceSessionId: event.sourceSessionId,
          eventType: event.eventType,
          payload: event.payload,
          createdAt: event.createdAt,
        })),
      getSourceSessionWakeContext: async (sourceSessionId) => {
        const row = await db.getSession(sourceSessionId);
        const callerInfo = extractCallerInfoFromMetadata(row?.metadata);
        return {
          agentId: row?.agent_id ?? null,
          callerSource: typeof callerInfo?.source === "string" ? callerInfo.source : null,
        };
      },
      setCursor: async (supervisorId, cursorOffset) => {
        await db.setSupervisorConsumerCursor(supervisorId, cursorOffset);
      },
      getWakeDispatchState: async (supervisorId) => {
        const registry = await db.getSupervisorRegistry(supervisorId);
        return {
          state: registry?.wakeDispatchState ?? "active",
          lastSignature: registry?.wakeLastSignature ?? null,
          repeatCount: registry?.wakeRepeatCount ?? 0,
        };
      },
      setWakeDispatchState: async (state) => {
        await db.setSupervisorWakeDispatchState({
          role: state.supervisorId,
          state: state.state,
          lastSignature: state.lastSignature,
          repeatCount: state.repeatCount,
          blockedReason: state.blockedReason,
          blockedAt: state.blockedAt,
        });
      },
      wake: async ({ supervisorId, events, wakeClass }) => {
        const registry = await db.getSupervisorRegistry(supervisorId);
        if (!registry?.activeSessionId) {
          logger.warn({ supervisorId, wakeClass }, "Supervisor wake skipped: no active session");
          return;
        }
        const sessions = await buildSupervisorWakeSessionSummaries(events, db, logger);
        await taskManager.addIntervention(
          {
            agentSessionId: registry.activeSessionId,
            text: buildSupervisorWakeText({
              supervisorId,
              wakeClass,
              events,
              sessions,
              now: new Date(),
            }),
            user: "supervisor",
          },
          onResume,
        );
      },
      wakeSnapshot: async ({ supervisorId }) => {
        const registry = await db.getSupervisorRegistry(supervisorId);
        if (!registry?.activeSessionId) {
          throw new Error(`Supervisor snapshot wake missing active session: ${supervisorId}`);
        }
        const sessions = await buildSupervisorSnapshotSessionSummaries(
          supervisorId,
          db,
          logger,
          shouldDispatchSupervisorWakeCandidate,
        );
        await taskManager.addIntervention(
          {
            agentSessionId: registry.activeSessionId,
            text: buildSupervisorSnapshotWakeText({ supervisorId, sessions, now: new Date() }),
            user: "supervisor",
          },
          onResume,
        );
      },
      logger,
    },
    { batchLimit: env.SUPERVISOR_WAKE_BATCH_LIMIT },
  );
  const supervisorWakeScheduler = env.SUPERVISOR_ENABLED
    ? new SupervisorWakeScheduler(
        {
          listSupervisors: () => db.listSupervisorRegistries(),
          router: supervisorWakeRouter,
          logger,
        },
        { debounceMs: env.SUPERVISOR_WAKE_DEBOUNCE_MS },
      )
    : undefined;
  const supervisorEventSourceNode =
    env.SUPERVISOR_ENABLED || env.SUPERVISOR_EVENT_INGEST_ENABLED
      ? env.SOULSTREAM_NODE_ID
      : undefined;
  const runningSupervisorHandovers = new Set<string>();
  const lastSupervisorHandoverAt = new Map<string, number>();
  const supervisorHandoverRunner = {
    async run(registry: Awaited<ReturnType<typeof db.recordSupervisorUsageDelta>>) {
      if (runningSupervisorHandovers.has(registry.role)) return;
      const lastHandoverAt = lastSupervisorHandoverAt.get(registry.role) ?? 0;
      if (Date.now() - lastHandoverAt < env.SUPERVISOR_HANDOVER_MIN_INTERVAL_MS) {
        logger.warn({ role: registry.role }, "Supervisor handover skipped by minimum interval guard");
        return;
      }

      runningSupervisorHandovers.add(registry.role);
      let replacementTask = null as Awaited<ReturnType<typeof taskManager.createTask>> | null;
      try {
        await new SupervisorHandoverExecutor({
          bootReplacement: async ({ role, previousSessionId }) => {
            const sessionId = `supervisor-${role}-${randomUUID()}`;
            replacementTask = await taskManager.createTask({
              agentSessionId: sessionId,
              prompt: buildSupervisorHandoverPrompt({
                role,
                previousSessionId,
                asOfOffset: registry.cursorOffset,
                events: [],
                promptEventLimit: env.SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT,
              }),
              profileId: role,
              folderId: env.SUPERVISOR_FOLDER_ID,
              callerInfo: { source: "agent", display_name: "supervisor" },
            });
            return { sessionId };
          },
          injectSnapshot: async ({ role, previousSessionId, asOfOffset }) => {
            if (!replacementTask) return;
            replacementTask.prompt = buildSupervisorHandoverPrompt({
              role,
              previousSessionId,
              asOfOffset,
              events: [],
              promptEventLimit: env.SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT,
            });
          },
          drainReplacement: async ({ role, fromOffset }) => {
            const events = await db.readSupervisorEventsAfter(
              fromOffset,
              env.SUPERVISOR_HANDOVER_DRAIN_LIMIT,
            );
            const cursorOffset = events[events.length - 1]?.offset ?? fromOffset;
            if (replacementTask) {
              replacementTask.prompt = buildSupervisorHandoverPrompt({
                role,
                previousSessionId: registry.activeSessionId ?? "",
                asOfOffset: fromOffset,
                events,
                promptEventLimit: env.SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT,
              });
            }
            return { cursorOffset };
          },
          activateReplacement: async (activation) => {
            await db.upsertSupervisorRegistry(activation);
            if (!replacementTask) {
              throw new Error(`Replacement task missing for supervisor role: ${activation.role}`);
            }
            const agent = agentRegistry.get(activation.role);
            if (!agent) throw new Error(`Supervisor profile not found: ${activation.role}`);
            taskExecutor.startExecution(replacementTask, agent);
          },
          killPrevious: async ({ role, previousSessionId }) => {
            if (!(await taskManager.cancelTask(previousSessionId))) {
              logger.warn({ role, previousSessionId }, "Previous supervisor session was not running");
            }
          },
        }).run(registry);
        lastSupervisorHandoverAt.set(registry.role, Date.now());
      } finally {
        runningSupervisorHandovers.delete(registry.role);
      }
    },
  };

  taskExecutor = new TaskExecutor(
    engineFactory,
    db,
    persistence,
    broadcaster,
    logger,
    contextBuilder,
    completionNotifier,
    scheduleService.makeToolHandler(),
    claudeRuntimeTaskFollowup,
    supervisorWakeScheduler,
    supervisorEventSourceNode,
    env.SUPERVISOR_ENABLED ? supervisorHandoverRunner : undefined,
    {
      softTokenThreshold: env.SUPERVISOR_SOFT_TOKEN_THRESHOLD,
      hardTokenThreshold: env.SUPERVISOR_HARD_TOKEN_THRESHOLD,
    },
  );
  const scheduleDispatcher = new ScheduleDispatcher(
    { nodeId: env.SOULSTREAM_NODE_ID },
    scheduleService,
    taskManager,
    onResume,
    logger,
  );
  scheduleDispatcher.start();
  const supervisorWatchdogInterval = env.SUPERVISOR_ENABLED
    ? setInterval(() => {
        void (async () => {
          try {
            const alerts = detectMissingSupervisors(
              await db.listSupervisorRegistries(),
              new Date(),
              env.SUPERVISOR_WATCHDOG_MISSING_THRESHOLD_MS,
            );
            for (const alert of alerts) logger.warn({ supervisor: alert }, "Supervisor watchdog alert");
          } catch (err) {
            logger.warn({ err }, "Supervisor watchdog check failed");
          }
        })();
      }, env.SUPERVISOR_WATCHDOG_INTERVAL_MS)
    : undefined;

  return {
    taskExecutor,
    onResume,
    scheduleDispatcher,
    supervisorWakeScheduler,
    supervisorWatchdogInterval,
  };
}

async function buildSupervisorWakeSessionSummaries(
  events: SupervisorWakeEvent[],
  db: Pick<SessionDB, "getSession">,
  logger: Pick<Logger, "warn">,
): Promise<Record<string, SupervisorWakeSessionSummary>> {
  const summaries: Record<string, SupervisorWakeSessionSummary> = {};
  const sourceSessionIds = new Set<string>();
  for (const event of events) if (event.sourceSessionId) sourceSessionIds.add(event.sourceSessionId);
  for (const sourceSessionId of sourceSessionIds) {
    try {
      summaries[sourceSessionId] = wakeSessionSummaryFromRow(
        sourceSessionId,
        await db.getSession(sourceSessionId),
      );
    } catch (err) {
      logger.warn({ err, sourceSessionId }, "Supervisor wake session summary lookup failed");
      summaries[sourceSessionId] = { sessionId: sourceSessionId };
    }
  }
  return summaries;
}

function buildSupervisorHandoverPrompt(params: {
  role: string;
  previousSessionId: string;
  asOfOffset: number;
  events: SupervisorEventRow[];
  promptEventLimit?: number;
}): string {
  const head = params.events[params.events.length - 1]?.offset ?? params.asOfOffset;
  const promptEventLimit = params.promptEventLimit ?? 20;
  const eventLines = params.events.slice(0, promptEventLimit).map((event) =>
    `- #${event.offset} ${event.eventType} session=${event.sourceSessionId} event=${event.sourceEventId}`,
  );
  const lines = [
    `[supervisor handover] role=${params.role}`,
    `previous_session=${params.previousSessionId}`,
    `as_of_offset=${params.asOfOffset}`,
    `drained_head=${head}`,
    "You are the replacement supervisor. Continue from the drained supervisor_events summary and keep watching subsequent wake messages.",
    ...eventLines,
  ];
  if (params.events.length > eventLines.length) {
    lines.push(`- ... ${params.events.length - eventLines.length} more`);
  }
  return lines.join("\n");
}
