import type { Logger } from "pino";

import { CommandDispatcher, type SendFn } from "./dispatcher.js";
import type { UpstreamDependencies } from "./adapter_types.js";

export function createUpstreamCommandDispatcher(input: {
  send: SendFn;
  logger: Logger;
  nodeId: string;
  dependencies: UpstreamDependencies;
  listRunningSessionIds(): Promise<string[]>;
}): CommandDispatcher {
  const deps = input.dependencies;
  return new CommandDispatcher(
    input.send,
    input.logger,
    input.nodeId,
    deps.agentRegistry,
    deps.taskManager,
    deps.taskExecutor,
    deps.attachmentStore,
    deps.claudeAuth,
    deps.sessionDb,
    deps.realtimeBroker,
    undefined,
    deps.agentConfigService,
    deps.reflectionRuntime,
    deps.scheduleCommands,
    deps.deliveryV2Enabled,
    deps.modelCatalog,
    deps.agentProfileSource,
    input.listRunningSessionIds,
  );
}
