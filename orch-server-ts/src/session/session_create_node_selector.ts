import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "../node/registry.js";

export type SessionCreateNodeSelectionRequest = {
  readonly nodeId?: string;
  readonly profileId?: string;
};

export type SessionCreateNodeSelection = {
  readonly node: NodeConnectionSnapshot;
  readonly profileId: string;
  readonly backend: string;
};

export type SessionCreateNodeSelectionErrorCode =
  | "NO_AVAILABLE_NODE"
  | "NODE_NOT_FOUND"
  | "PROFILE_NOT_FOUND"
  | "BACKEND_INCOMPATIBLE"
  | "NO_COMPATIBLE_PROFILE";

export class SessionCreateNodeSelectionError extends Error {
  readonly statusCode: 404 | 409 | 503;
  readonly code: SessionCreateNodeSelectionErrorCode;
  readonly nodeId: string | undefined;
  readonly profileId: string | undefined;
  readonly backend: string | undefined;

  constructor(params: {
    statusCode: 404 | 409 | 503;
    code: SessionCreateNodeSelectionErrorCode;
    message: string;
    nodeId?: string;
    profileId?: string;
    backend?: string;
  }) {
    super(params.message);
    this.name = "SessionCreateNodeSelectionError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.nodeId = params.nodeId;
    this.profileId = params.profileId;
    this.backend = params.backend;
  }
}

export function selectNodeForSessionCreate(
  registry: InMemoryNodeRegistry,
  request: SessionCreateNodeSelectionRequest,
): SessionCreateNodeSelection {
  const nodes = registry.listConnectedNodesInRegistrationOrder();
  if (nodes.length === 0) {
    throw selectionError(503, "NO_AVAILABLE_NODE", "No nodes available");
  }

  if (request.nodeId !== undefined) {
    return selectRequestedNode(registry, {
      nodeId: request.nodeId,
      profileId: request.profileId,
    });
  }
  return selectAutomaticNode(registry, nodes, request.profileId);
}

function selectRequestedNode(
  registry: InMemoryNodeRegistry,
  request: { readonly nodeId: string; readonly profileId?: string },
): SessionCreateNodeSelection {
  const nodeId = request.nodeId;
  const node = registry.getConnectedNode(nodeId);
  if (node === undefined) {
    throw selectionError(404, "NODE_NOT_FOUND", `Node ${nodeId} not found`, {
      nodeId,
    });
  }

  const profile = request.profileId === undefined
    ? compatibleProfiles(node)[0]
    : findProfile(node, request.profileId);
  if (profile === undefined) {
    if (request.profileId !== undefined) {
      throw selectionError(
        404,
        "PROFILE_NOT_FOUND",
        `Agent profile '${request.profileId}' is not registered on node ${nodeId}`,
        { nodeId, profileId: request.profileId },
      );
    }
    throw selectionError(
      503,
      "NO_COMPATIBLE_PROFILE",
      `No compatible agent profile registered on node ${nodeId}`,
      { nodeId },
    );
  }
  assertBackendCompatibility(node, profile);
  return { node, profileId: profile.id, backend: profile.backend };
}

function selectAutomaticNode(
  registry: InMemoryNodeRegistry,
  nodes: NodeConnectionSnapshot[],
  profileId: string | undefined,
): SessionCreateNodeSelection {
  if (profileId !== undefined) {
    const eligible = nodes.flatMap((node) => {
      const profile = findProfile(node, profileId);
      return profile === undefined ? [] : [{ node, profile }];
    });
    if (eligible.length === 0) {
      throw selectionError(
        404,
        "PROFILE_NOT_FOUND",
        `Agent profile '${profileId}' is not registered on any connected node`,
        { profileId },
      );
    }
    const compatible = eligible.filter(({ node, profile }) =>
      node.supportedBackends.includes(profile.backend),
    );
    if (compatible.length === 0) {
      throw selectionError(
        409,
        "BACKEND_INCOMPATIBLE",
        `Agent profile '${profileId}' is registered on connected nodes but none supports its configured backend`,
        { profileId },
      );
    }
    return toSelection(leastLoaded(registry, compatible));
  }

  const compatibleDefaults = nodes.flatMap((node) =>
    compatibleProfiles(node).map((profile) => ({ node, profile })),
  );
  if (compatibleDefaults.length === 0) {
    throw selectionError(
      503,
      "NO_COMPATIBLE_PROFILE",
      "No compatible agent profiles available on connected nodes",
    );
  }
  return toSelection(leastLoaded(registry, compatibleDefaults));
}

type NodeProfileCandidate = {
  readonly node: NodeConnectionSnapshot;
  readonly profile: AgentProfile;
};

type AgentProfile = {
  readonly id: string;
  readonly backend: string;
};

function leastLoaded(
  registry: InMemoryNodeRegistry,
  candidates: NodeProfileCandidate[],
): NodeProfileCandidate {
  const [first, ...rest] = candidates;
  if (first === undefined) throw new Error("leastLoaded requires candidates");
  return rest.reduce((selected, candidate) =>
    sessionCount(registry, candidate.node) < sessionCount(registry, selected.node)
      ? candidate
      : selected,
  first);
}

function sessionCount(
  registry: InMemoryNodeRegistry,
  node: NodeConnectionSnapshot,
): number {
  return registry.sessionCache.getSessionsForNode(node.nodeId).length;
}

function toSelection(candidate: NodeProfileCandidate): SessionCreateNodeSelection {
  return {
    node: candidate.node,
    profileId: candidate.profile.id,
    backend: candidate.profile.backend,
  };
}

function compatibleProfiles(node: NodeConnectionSnapshot): AgentProfile[] {
  return profiles(node).filter((profile) =>
    node.supportedBackends.includes(profile.backend),
  );
}

function findProfile(
  node: NodeConnectionSnapshot,
  profileId: string,
): AgentProfile | undefined {
  return profiles(node).find((profile) => profile.id === profileId);
}

function profiles(node: NodeConnectionSnapshot): AgentProfile[] {
  return node.agents.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
      return [];
    }
    return [{
      id: candidate.id,
      backend:
        typeof candidate.backend === "string" && candidate.backend.length > 0
          ? candidate.backend
          : "claude",
    }];
  });
}

function assertBackendCompatibility(
  node: NodeConnectionSnapshot,
  profile: AgentProfile,
): void {
  if (node.supportedBackends.includes(profile.backend)) return;
  throw selectionError(
    409,
    "BACKEND_INCOMPATIBLE",
    `Node ${node.nodeId} does not support backend '${profile.backend}' (supports: ${node.supportedBackends.join(",")})`,
    { nodeId: node.nodeId, profileId: profile.id, backend: profile.backend },
  );
}

function selectionError(
  statusCode: 404 | 409 | 503,
  code: SessionCreateNodeSelectionErrorCode,
  message: string,
  metadata: { nodeId?: string; profileId?: string; backend?: string } = {},
): SessionCreateNodeSelectionError {
  return new SessionCreateNodeSelectionError({
    statusCode,
    code,
    message,
    ...metadata,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
