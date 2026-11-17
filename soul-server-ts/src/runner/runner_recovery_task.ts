import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import type { Task } from "../task/task_models.js";
import type { RunnerRegistration } from "./runner_process_registry.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";

const recoveredTasksWithAgentRefs = new WeakSet<Task>();

export async function markRegistrationReaped(
  registration: RunnerRegistration,
  progressedAt: string,
  error: { code: string; message: string },
  logger: Pick<Logger, "error" | "info" | "warn">,
): Promise<void> {
  const writerLock = await RunnerWriterLock.acquire(registration.config.paths.lockPath);
  try {
    const lifecycle = RunnerSqliteLifecycle.open(
      registration.config.paths.databasePath,
      undefined,
      {
        onSummaryRenameFailure: (renameError, path, details) => {
          const context = {
            err: renameError,
            path,
            consecutiveFailures: details.consecutiveFailures,
          };
          if (details.severity === "error") {
            logger.error(
              context,
              "Runner lifecycle summary rename failure persisted; durable SQLite state retained",
            );
          } else {
            logger.warn(
              context,
              "Runner lifecycle summary rename retries exhausted; durable SQLite state retained",
            );
          }
        },
        onSummaryRenameRecovery: (path, recoveredAfterFailures) => logger.info(
          { path, recoveredAfterFailures },
          "Runner lifecycle summary rename recovered",
        ),
      },
    );
    try {
      lifecycle.reap(
        registration.lifecycle!.execution_command_id,
        progressedAt,
        error,
      );
    } finally {
      lifecycle.close();
    }
  } finally {
    await writerLock.release();
  }
}

export function prepareRecoveredTask(
  task: Task,
  registration: RunnerRegistration,
): void {
  task.agentProfileSnapshot = registration.config.agent;
  if (registration.config.mcpSecretRefs?.some((ref) => ref.location === "agent")) {
    recoveredTasksWithAgentRefs.add(task);
  } else {
    recoveredTasksWithAgentRefs.delete(task);
  }
  const backendSessionId = registration.bootstrap?.payload.backend_session_id;
  if (backendSessionId) task.codexThreadId = backendSessionId;
}

/** Refresh only MCP lists stripped from the persisted profile before a new spawn. */
export function resolveRecoveredAgentMcp(
  task: Task,
  agent: AgentProfile,
  getProfile: (profileId: string) => AgentProfile | undefined,
): AgentProfile {
  if (!recoveredTasksWithAgentRefs.has(task)) return agent;
  const profileId = task.profileId ?? "(missing)";
  const agents = agent.agents_sdk?.agents ?? [];
  const current = task.profileId ? getProfile(task.profileId) : undefined;
  const restored = agents.map((saved) => {
    const match = current?.agents_sdk?.agents.find((candidate) => candidate.id === saved.id);
    if (!match) throw new Error(`MCP profile unavailable: ${profileId} ${saved.id}`);
    return { ...saved, mcp_servers: match.mcp_servers };
  });
  if (!current) throw new Error(`MCP profile unavailable: ${profileId} ${agents[0]?.id ?? "(missing)"}`);
  return agent.agents_sdk ? { ...agent, agents_sdk: { ...agent.agents_sdk, agents: restored } } : agent;
}

export function requireRecoveryTask(
  task: Task | undefined,
  registration: RunnerRegistration,
): Task {
  if (task) return task;
  throw new Error(
    `runner recovery task missing after hydration: ${registration.config.sessionId}`,
  );
}
