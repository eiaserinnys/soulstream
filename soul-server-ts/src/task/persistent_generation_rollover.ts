import type { AgentProfile } from "../agent_registry.js";
import type { ModelCatalog } from "../model_catalog.js";

import type { ActiveGenerationRollover, Task } from "./task_models.js";

export function beginGenerationRolloverIfPending(
  _task: Task,
  _agent: AgentProfile,
  _modelCatalog?: Pick<ModelCatalog, "resolve">,
): ActiveGenerationRollover | undefined {
  return undefined;
}
