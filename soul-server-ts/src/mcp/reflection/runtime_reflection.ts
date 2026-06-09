import type { McpRuntime } from "../runtime.js";

import type { ProbeStatus, ReflectionError } from "./types.js";

export interface RuntimeReflectionData extends Record<string, unknown> {
  process: {
    pid: number;
    cwd: string;
    exec_path: string;
    argv: string[];
    uptime_seconds: number;
    memory: {
      rss: number;
      heap_total: number;
      heap_used: number;
      external: number;
      array_buffers: number;
    };
  };
  counts: {
    agent_count: number;
    active_task_count: number;
    tasks_by_status: Record<string, number>;
  };
  dependencies: {
    database: {
      status: ProbeStatus;
      checked_at: string;
      reason?: string;
    };
    orchestrator: {
      status: ProbeStatus;
      checked_at: string;
      base_url?: string;
      auth_header_configured?: boolean;
      reason?: string;
    };
  };
  supervisor_wake: SupervisorWakeReflectionData;
  errors: ReflectionError[];
}

export interface SupervisorWakeReflectionData {
  status: ProbeStatus;
  total: number;
  blocked_count: number;
  blocked_roles: string[];
  states_by_role: Record<string, {
    state: string;
    active_session_id: string | null;
    repeat_count: number;
    blocked_reason: string | null;
    blocked_at: string | null;
  }>;
  reason?: string;
}

export async function buildRuntimeReflection(
  runtime: McpRuntime,
): Promise<RuntimeReflectionData> {
  const memory = process.memoryUsage();
  const tasks = runtime.taskManager.listTasks();
  const database = await probeDatabase(runtime);
  const orchestrator = probeOrchestrator(runtime);
  const supervisorWake = await probeSupervisorWake(runtime);
  const errors = [
    ...probeError("database", database),
    ...probeError("orchestrator", orchestrator),
    ...supervisorWakeErrors(supervisorWake),
  ];
  return {
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      exec_path: process.execPath,
      argv: [...process.argv],
      uptime_seconds: Math.floor(process.uptime()),
      memory: {
        rss: memory.rss,
        heap_total: memory.heapTotal,
        heap_used: memory.heapUsed,
        external: memory.external,
        array_buffers: memory.arrayBuffers,
      },
    },
    counts: {
      agent_count: runtime.agentRegistry.list().length,
      active_task_count: tasks.length,
      tasks_by_status: countTasksByStatus(tasks),
    },
    dependencies: {
      database,
      orchestrator,
    },
    supervisor_wake: supervisorWake,
    errors,
  };
}

async function probeDatabase(
  runtime: McpRuntime,
): Promise<{ status: ProbeStatus; checked_at: string; reason?: string }> {
  const checkedAt = new Date().toISOString();
  const db = runtime.db as { ping?: () => Promise<void> };
  if (typeof db.ping !== "function") {
    return {
      status: "unavailable",
      checked_at: checkedAt,
      reason: "SessionDB.ping is not available on this runtime object",
    };
  }
  try {
    await db.ping.call(runtime.db);
    return { status: "ok", checked_at: checkedAt };
  } catch (err) {
    return {
      status: "unavailable",
      checked_at: checkedAt,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeOrchestrator(runtime: McpRuntime): RuntimeReflectionData["dependencies"]["orchestrator"] {
  const checkedAt = new Date().toISOString();
  if (!runtime.orch) {
    return {
      status: "not_configured",
      checked_at: checkedAt,
      reason: "orchestrator proxy config was not injected into McpRuntime",
    };
  }
  return {
    status: "unavailable",
    checked_at: checkedAt,
    base_url: runtime.orch.baseUrl,
    auth_header_configured: Boolean(
      runtime.orch.headers.authorization || runtime.orch.headers.Authorization,
    ),
    reason:
      "orchestrator HTTP config is present, but live upstream socket state is not exposed to McpRuntime",
  };
}

async function probeSupervisorWake(
  runtime: McpRuntime,
): Promise<SupervisorWakeReflectionData> {
  const db = runtime.db as {
    listSupervisorRegistries?: () => Promise<Array<{
      role: string;
      activeSessionId?: string | null;
      wakeDispatchState?: string | null;
      wakeRepeatCount?: number | null;
      wakeBlockedReason?: string | null;
      wakeBlockedAt?: Date | string | null;
    }>>;
  };
  if (typeof db.listSupervisorRegistries !== "function") {
    return {
      status: "unavailable",
      total: 0,
      blocked_count: 0,
      blocked_roles: [],
      states_by_role: {},
      reason: "SessionDB.listSupervisorRegistries is not available on this runtime object",
    };
  }

  try {
    const registries = await db.listSupervisorRegistries.call(runtime.db);
    const statesByRole: SupervisorWakeReflectionData["states_by_role"] = {};
    const blockedRoles: string[] = [];
    for (const registry of registries) {
      const state = registry.wakeDispatchState ?? "active";
      if (state === "blocked") blockedRoles.push(registry.role);
      statesByRole[registry.role] = {
        state,
        active_session_id: registry.activeSessionId ?? null,
        repeat_count: registry.wakeRepeatCount ?? 0,
        blocked_reason: registry.wakeBlockedReason ?? null,
        blocked_at: registry.wakeBlockedAt
          ? new Date(registry.wakeBlockedAt).toISOString()
          : null,
      };
    }
    return {
      status: blockedRoles.length > 0 ? "partial" : "ok",
      total: registries.length,
      blocked_count: blockedRoles.length,
      blocked_roles: blockedRoles,
      states_by_role: statesByRole,
    };
  } catch (err) {
    return {
      status: "unavailable",
      total: 0,
      blocked_count: 0,
      blocked_roles: [],
      states_by_role: {},
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeError(
  name: string,
  probe: { status: ProbeStatus; reason?: string },
): ReflectionError[] {
  if (probe.status === "ok" || probe.status === "not_configured") return [];
  return [
    {
      code: `${name}_${probe.status}`,
      message: `${name} status is ${probe.status}`,
      detail: probe.reason ? { reason: probe.reason } : undefined,
    },
  ];
}

function supervisorWakeErrors(
  probe: SupervisorWakeReflectionData,
): ReflectionError[] {
  if (probe.blocked_count > 0) {
    return [
      {
        code: "supervisor_wake_dispatch_blocked",
        message: "supervisor wake dispatch is blocked",
        detail: {
          roles: probe.blocked_roles,
          states_by_role: probe.states_by_role,
        },
      },
    ];
  }
  if (probe.status === "unavailable" && probe.reason) {
    return [
      {
        code: "supervisor_wake_unavailable",
        message: "supervisor wake state is unavailable",
        detail: { reason: probe.reason },
      },
    ];
  }
  return [];
}

function countTasksByStatus(tasks: Array<{ status?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = task.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
