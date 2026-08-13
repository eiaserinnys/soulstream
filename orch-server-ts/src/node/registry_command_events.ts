import type { NodeCommandResponse } from "./pending_commands.js";
import type { NodeRegistryEvent } from "./registry_types.js";

export function resolvedCommandEvents(params: {
  nodeId: string;
  requestId: string;
  commandType: string;
  response: NodeCommandResponse;
}): NodeRegistryEvent[] {
  const events: NodeRegistryEvent[] = [
    {
      type: "command_ack",
      nodeId: params.nodeId,
      requestId: params.requestId,
      commandType: params.commandType,
    },
  ];
  if (params.response.type === "runner_inventory") {
    events.push({
      type: "node_runner_inventory",
      nodeId: params.nodeId,
      data: params.response,
    });
  }
  return events;
}
