import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import { supportsClaudeAccountPool } from "../node/registry_helpers.js";

type SharedProviderGroup = {
  readonly provider: string;
  readonly nodeIds: readonly string[];
};

export function resolveProviderOwners(
  connectedNodes: readonly NodeConnectionSnapshot[],
  groups: readonly SharedProviderGroup[],
): Map<string, string> {
  const owners = new Map<string, string>();
  const connectedById = new Map(connectedNodes.map((node) => [node.nodeId, node]));
  for (const group of groups) {
    const connectedMembers = group.nodeIds
      .map((nodeId) => connectedById.get(nodeId))
      .filter((node): node is NodeConnectionSnapshot => node !== undefined);
    const sharedMembers = group.provider === "claude"
      ? connectedMembers.filter((node) => !supportsClaudeAccountPool(node.capabilities))
      : connectedMembers;
    const representative = sharedMembers[0]?.nodeId;
    if (representative === undefined) continue;
    for (const node of sharedMembers) {
      owners.set(providerRequestKey(node.nodeId, group.provider), representative);
    }
  }
  return owners;
}

export function providerRequestKey(nodeId: string, provider: string): string {
  return `${nodeId}\u0000${provider}`;
}
