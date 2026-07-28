import type { PageBatchOperation } from "./page_mutation_core.js";
import type { PageSessionDefaultsDto } from "./page_repository_reads.js";

export type AgentIdResolver = (nodeId: string, agentId: string) => string;

export function canonicalizeSessionDefaults(
  defaults: PageSessionDefaultsDto | null,
  resolveAgentId: AgentIdResolver | undefined,
): PageSessionDefaultsDto | null {
  if (!defaults?.agentId || !defaults.nodeId || !resolveAgentId) return defaults;
  return {
    ...defaults,
    agentId: resolveAgentId(defaults.nodeId, defaults.agentId),
  };
}

export function canonicalizeSessionDefaultsOperation(
  operation: PageBatchOperation,
  resolveAgentId: AgentIdResolver | undefined,
): PageBatchOperation {
  if (
    !resolveAgentId
    || (
      operation.op !== "create_block"
      && operation.op !== "update_block_type_and_properties"
    )
    || operation.blockType !== "session_defaults"
  ) {
    return operation;
  }
  const agentId = operation.properties.agentId;
  const nodeId = operation.properties.nodeId;
  if (typeof agentId !== "string" || typeof nodeId !== "string") return operation;
  return {
    ...operation,
    properties: {
      ...operation.properties,
      agentId: resolveAgentId(nodeId, agentId),
    },
  };
}
