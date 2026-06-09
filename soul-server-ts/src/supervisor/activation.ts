import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { SessionDB, SupervisorRegistryRow } from "../db/session_db.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";

export interface SupervisorActivationConfig {
  enabled: boolean;
  roles: string[];
  folderId?: string;
}

export type SupervisorActivationStatus = "disabled" | "existing" | "started";

export interface SupervisorActivationResult {
  role: string;
  status: SupervisorActivationStatus;
  sessionId?: string;
}

export interface SupervisorActivationDeps {
  config: SupervisorActivationConfig;
  agentRegistry: Pick<AgentRegistry, "get">;
  db: Pick<
    SessionDB,
    "getSupervisorRegistry" | "getSession" | "upsertSupervisorRegistry" | "updateSession"
  >;
  taskManager: Pick<TaskManager, "createTask" | "cancelTask" | "getTask">;
  taskExecutor: Pick<TaskExecutor, "startExecution">;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
  sessionIdFactory?: (role: string) => string;
}

export function buildSupervisorBootPrompt(role: string): string {
  return [
    `[supervisor bootstrap] role=${role}`,
    "Watch supervisor wake messages and decide whether action is needed.",
    "The durable supervisor registry has selected this session as the active supervisor for the role.",
    "When a wake message arrives, inspect the event summary before intervening.",
  ].join("\n");
}

export async function startConfiguredSupervisors(
  deps: SupervisorActivationDeps,
): Promise<SupervisorActivationResult[]> {
  if (!deps.config.enabled) {
    return [{ role: "", status: "disabled" }];
  }

  validateConfiguredSupervisors(deps.config, deps.agentRegistry);

  const results: SupervisorActivationResult[] = [];
  for (const role of deps.config.roles) {
    results.push(await ensureSupervisorStarted(deps, role));
  }
  return results;
}

export function validateConfiguredSupervisors(
  config: SupervisorActivationConfig,
  agentRegistry: Pick<AgentRegistry, "get">,
): void {
  if (!config.enabled) return;

  for (const role of config.roles) {
    if (!agentRegistry.get(role)) {
      throw new Error(`Supervisor role not found in agents.yaml: ${role}`);
    }
  }
}

async function ensureSupervisorStarted(
  deps: SupervisorActivationDeps,
  role: string,
): Promise<SupervisorActivationResult> {
  const agent = deps.agentRegistry.get(role);
  if (!agent) {
    throw new Error(`Supervisor role not found in agents.yaml: ${role}`);
  }

  const existing = await deps.db.getSupervisorRegistry(role);
  if (
    existing?.activeSessionId &&
    await isReusableActiveSupervisorSession(deps, role, existing.activeSessionId)
  ) {
    return {
      role,
      status: "existing",
      sessionId: existing.activeSessionId,
    };
  }

  const sessionId = deps.sessionIdFactory?.(role) ?? `supervisor-${role}-${randomUUID()}`;
  const task = await deps.taskManager.createTask({
    agentSessionId: sessionId,
    prompt: buildSupervisorBootPrompt(role),
    profileId: role,
    callerInfo: {
      source: "agent",
      display_name: "supervisor",
      agent_id: role,
      agent_name: agent.name,
    },
    folderId: deps.config.folderId,
  });

  try {
    await deps.db.upsertSupervisorRegistry({
      role,
      activeSessionId: sessionId,
      epoch: nextEpoch(existing),
      cursorOffset: existing?.cursorOffset ?? 0,
      handoverState: "idle",
      cumulativeTokens: 0,
      compactionCount: existing?.compactionCount ?? 0,
      lastSeenAt: deps.now?.() ?? new Date(),
    });
  } catch (err) {
    await finalizeCreatedSupervisorSession(deps, role, sessionId, "registry upsert error");
    throw err;
  }

  try {
    deps.taskExecutor.startExecution(task, agent);
  } catch (err) {
    await finalizeCreatedSupervisorSession(deps, role, sessionId, "start error");
    await rollbackSupervisorRegistry(deps, role, existing).catch((rollbackErr) => {
      deps.logger.warn(
        { err: rollbackErr, role, sessionId },
        "Supervisor activation registry rollback failed after start error",
      );
    });
    throw err;
  }
  deps.logger.info(
    { role, sessionId },
    "Supervisor activation started missing supervisor session",
  );

  return {
    role,
    status: "started",
    sessionId,
  };
}

async function isReusableActiveSupervisorSession(
  deps: SupervisorActivationDeps,
  role: string,
  sessionId: string,
): Promise<boolean> {
  const activeTask = deps.taskManager.getTask(sessionId);
  const existingSession = await deps.db.getSession(sessionId);
  const reusable = Boolean(
    activeTask?.status === "running" &&
    activeTask.profileId === role &&
    existingSession?.status === "running" &&
    existingSession.agent_id === role,
  );
  if (!reusable) {
    deps.logger.warn(
      {
        role,
        sessionId,
        taskStatus: activeTask?.status ?? null,
        sessionStatus: existingSession?.status ?? null,
        sessionAgentId: existingSession?.agent_id ?? null,
      },
      "Supervisor activation ignored stale active session",
    );
  }
  return reusable;
}

function nextEpoch(existing: SupervisorRegistryRow | null): number {
  if (!existing?.activeSessionId) return existing?.epoch ?? 0;
  return existing.epoch + 1;
}

async function rollbackSupervisorRegistry(
  deps: SupervisorActivationDeps,
  role: string,
  existing: SupervisorRegistryRow | null,
): Promise<void> {
  await deps.db.upsertSupervisorRegistry({
    role,
    activeSessionId: existing?.activeSessionId ?? null,
    epoch: existing?.epoch ?? 0,
    cursorOffset: existing?.cursorOffset ?? 0,
    handoverState: existing?.handoverState ?? "idle",
    cumulativeTokens: existing?.cumulativeTokens ?? 0,
    compactionCount: existing?.compactionCount ?? 0,
    lastSeenAt: existing?.lastSeenAt ?? null,
  });
}

async function finalizeCreatedSupervisorSession(
  deps: SupervisorActivationDeps,
  role: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await deps.taskManager.cancelTask(sessionId).catch((cancelErr) => {
    deps.logger.warn(
      { err: cancelErr, role, sessionId },
      `Supervisor activation cleanup failed after ${reason}`,
    );
  });
  await deps.db.updateSession(sessionId, {
    status: "interrupted",
    termination_reason: "killed",
    termination_detail: `supervisor activation failed: ${reason}`,
  }).catch((updateErr) => {
    deps.logger.warn(
      { err: updateErr, role, sessionId },
      "Supervisor activation DB session cleanup failed",
    );
  });
}
