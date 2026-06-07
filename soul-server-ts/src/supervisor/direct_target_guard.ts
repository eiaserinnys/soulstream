import type { SessionDB } from "../db/session_db.js";
import type { TaskManager } from "../task/task_manager.js";

export class SupervisorDirectTargetError extends Error {
  constructor(params: {
    role: string;
    targetSessionId: string;
    activeSessionId: string | null;
  }) {
    super(
      `Stale supervisor session direct target rejected: role=${params.role}, target=${params.targetSessionId}, active=${params.activeSessionId ?? "none"}`,
    );
    this.name = "SupervisorDirectTargetError";
  }
}

export interface SupervisorDirectTargetGuardDeps {
  db: Pick<
    SessionDB,
    "getSession" | "getSupervisorRegistry" | "listSupervisorRegistries"
  >;
  taskManager?: Pick<TaskManager, "getTask">;
}

export class SupervisorDirectTargetGuard {
  constructor(private readonly deps: SupervisorDirectTargetGuardDeps) {}

  async assertCanTarget(sessionId: string): Promise<void> {
    const registries = await this.deps.db.listSupervisorRegistries();
    const active = registries.find((registry) => registry.activeSessionId === sessionId);
    if (active) return;

    const getTask = this.deps.taskManager?.getTask;
    const taskProfile = typeof getTask === "function"
      ? getTask.call(this.deps.taskManager, sessionId)?.profileId
      : undefined;
    const rowProfile = taskProfile ? null : (await this.deps.db.getSession(sessionId))?.agent_id;
    const role = taskProfile ?? rowProfile ?? null;
    if (!role) return;

    const registry = registries.find((candidate) => candidate.role === role);
    if (!registry) return;
    if (registry.activeSessionId === sessionId) return;

    throw new SupervisorDirectTargetError({
      role,
      targetSessionId: sessionId,
      activeSessionId: registry.activeSessionId,
    });
  }

  async resolveActiveSession(params: {
    role: string;
    expectedEpoch?: number;
  }): Promise<string> {
    const registry = await this.deps.db.getSupervisorRegistry(params.role);
    if (!registry?.activeSessionId) {
      throw new Error(`Supervisor role has no active session: ${params.role}`);
    }
    if (params.expectedEpoch !== undefined && registry.epoch !== params.expectedEpoch) {
      throw new Error(
        `Supervisor epoch mismatch: role=${params.role}, expected=${params.expectedEpoch}, active=${registry.epoch}`,
      );
    }
    return registry.activeSessionId;
  }
}
