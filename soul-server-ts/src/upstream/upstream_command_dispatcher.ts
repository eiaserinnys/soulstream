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
  return new CommandDispatcher({
    send: input.send,
    logger: input.logger,
    nodeId: input.nodeId,
    agentRegistry: deps.agentRegistry,
    taskManager: deps.taskManager,
    taskExecutor: deps.taskExecutor,
    attachmentStore: deps.attachmentStore,
    claudeAuth: deps.claudeAuth,
    sessionDb: deps.sessionDb,
    realtimeBroker: deps.realtimeBroker,
    agentConfigService: deps.agentConfigService,
    reflectionRuntime: deps.reflectionRuntime,
    scheduleCommands: deps.scheduleCommands,
    modelCatalog: deps.modelCatalog,
    agentProfileSource: deps.agentProfileSource,
    listRunningSessionIds: input.listRunningSessionIds,
    worktreeService: deps.worktreeService,
    decisionRunner: deps.decisionRunner,
    authorizeOrchestrationWorker: deps.authorizeOrchestrationWorker,
  });
}
