import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "./registry.js";

export type RegisteredAgentProfile = {
  readonly nodeId: string;
  readonly id: string;
  readonly backend: string;
  readonly defaultPreset?: string;
  readonly agent: Record<string, unknown>;
};

export function findNodeAgentProfile(
  node: NodeConnectionSnapshot,
  requestedId: string,
): RegisteredAgentProfile | undefined {
  const profiles = node.agents.flatMap((candidate) => {
    const agent = asRecord(candidate);
    const id = nonEmptyString(agent?.id);
    return agent && id ? [{ agent, id }] : [];
  });

  const canonical = profiles.find((profile) => profile.id === requestedId);
  if (canonical) return resolvedProfile(node.nodeId, canonical.agent, canonical.id);

  for (const profile of profiles) {
    const alias = aliases(profile.agent).find((candidate) => candidate.id === requestedId);
    if (!alias) continue;
    return resolvedProfile(
      node.nodeId,
      profile.agent,
      profile.id,
      alias.defaultPreset,
    );
  }
  return undefined;
}

export function findRegisteredAgentProfile(
  registry: InMemoryNodeRegistry,
  requestedId: string,
  preferredNodeId?: string,
): RegisteredAgentProfile | undefined {
  if (preferredNodeId) {
    const preferredNode = registry.getConnectedNode(preferredNodeId);
    return preferredNode
      ? findNodeAgentProfile(preferredNode, requestedId)
      : undefined;
  }
  for (const node of registry.listConnectedNodes()) {
    const profile = findNodeAgentProfile(node, requestedId);
    if (profile) return profile;
  }
  return undefined;
}

export function resolveRegisteredAgentId(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  requestedId: string,
): string {
  const node = registry.getConnectedNode(nodeId);
  return node
    ? findNodeAgentProfile(node, requestedId)?.id ?? requestedId
    : requestedId;
}

function resolvedProfile(
  nodeId: string,
  agent: Record<string, unknown>,
  id: string,
  aliasDefaultPreset?: string,
): RegisteredAgentProfile {
  const backend = nonEmptyString(agent.backend) ?? "claude";
  const defaultPreset =
    aliasDefaultPreset ?? nonEmptyString(agent.default_preset);
  return {
    nodeId,
    id,
    backend,
    ...(defaultPreset ? { defaultPreset } : {}),
    agent,
  };
}

function aliases(
  agent: Record<string, unknown>,
): Array<{ id: string; defaultPreset?: string }> {
  if (!Array.isArray(agent.aliases)) return [];
  return agent.aliases.flatMap((candidate) => {
    if (typeof candidate === "string") {
      const id = nonEmptyString(candidate);
      return id ? [{ id }] : [];
    }
    const record = asRecord(candidate);
    const id = nonEmptyString(record?.id);
    if (!id) return [];
    const defaultPreset = nonEmptyString(record?.default_preset);
    return [{
      id,
      ...(defaultPreset ? { defaultPreset } : {}),
    }];
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
