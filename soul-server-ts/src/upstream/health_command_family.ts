import type { AgentRegistry } from "../agent_registry.js";
import type { TaskManager } from "../task/task_manager.js";
import type {
  CommandHandlerMap,
  CommandLike,
  SendFn,
} from "./command_family.js";

interface HealthCommandFamilyDeps {
  send: SendFn;
  nodeId: string;
  agentRegistry: Pick<AgentRegistry, "list">;
  taskManager: Pick<TaskManager, "listTasks">;
}

export function createHealthCommandFamily(
  deps: HealthCommandFamilyDeps,
): CommandHandlerMap {
  return {
    health_check: (cmd) => handleHealthCheck(deps, cmd),
  };
}

async function handleHealthCheck(
  deps: HealthCommandFamilyDeps,
  cmd: CommandLike,
): Promise<void> {
  const agents = deps.agentRegistry.list();
  await deps.send({
    type: "health_status",
    runners: {
      max_concurrent: agents.length,
      active: deps.taskManager.listTasks().filter((t) => t.status === "running").length,
    },
    node_id: deps.nodeId,
    requestId: cmd.requestId ?? cmd.request_id ?? "",
  });
}
