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
      base_url?: string;
      auth_header_configured?: boolean;
      reason?: string;
    };
  };
  errors: ReflectionError[];
}

export async function buildRuntimeReflection(
  runtime: McpRuntime,
): Promise<RuntimeReflectionData> {
  const memory = process.memoryUsage();
  const tasks = runtime.taskManager.listTasks();
  const database = await probeDatabase(runtime);
  const orchestrator = probeOrchestrator(runtime);
  const errors = [
    ...probeError("database", database),
    ...probeError("orchestrator", orchestrator),
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
  if (!runtime.orch) {
    return {
      status: "not_configured",
      reason: "orchestrator proxy config was not injected into McpRuntime",
    };
  }
  return {
    status: "unavailable",
    base_url: runtime.orch.baseUrl,
    auth_header_configured: Boolean(
      runtime.orch.headers.authorization || runtime.orch.headers.Authorization,
    ),
    reason:
      "orchestrator HTTP config is present, but live upstream socket state is not exposed to McpRuntime",
  };
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

function countTasksByStatus(tasks: Array<{ status?: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = task.status ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
