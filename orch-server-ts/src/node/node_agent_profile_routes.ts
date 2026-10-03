// This route inventory shares existing validation/portrait helpers; splitting it is deferred to preserve the parallel extraction boundary.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ModelPresetAvailability,
  ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";

export type RawNodeAgentProfile = {
  name?: unknown;
  portrait_url?: unknown;
  max_turns?: unknown;
  backend?: unknown;
  aliases?: unknown;
  default_preset?: unknown;
};

export type NodeAgentProfiles = Record<string, RawNodeAgentProfile>;

export type PortraitBody = string | Buffer | Uint8Array;

export type NodePortraitResult =
  | { status: "missing" | "requestFailure" }
  | { status: "cached"; body: PortraitBody; encoding?: "base64" }
  | {
      status: "upstream";
      statusCode: number;
      body?: PortraitBody;
      contentType?: string;
      encoding?: "base64";
    };

export type NodePortraitRequestOptions = {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
};

export type AgentProfileUpdateInput = {
  profile: Record<string, unknown>;
  createIfMissing: boolean;
  includeTextDiff: boolean;
};

export type ApplyAgentProfileUpdateInput = AgentProfileUpdateInput & {
  expectedConfigChecksum?: string | null;
};

export type RollbackAgentsConfigInput = {
  snapshotPath?: string | null;
  snapshotId?: string | null;
  includeTextDiff: boolean;
};

export type AgentContextPreviewInput = {
  readonly atom_contexts: readonly unknown[];
  readonly session?: Readonly<Record<string, unknown>>;
};

export type NodeAgentProfileProvider = {
  listAgentProfiles: (nodeId: string) => Promise<NodeAgentProfiles | undefined>;
  getAgentPortrait: (
    nodeId: string,
    agentId: string,
    options?: NodePortraitRequestOptions,
  ) => Promise<NodePortraitResult>;
  getUserPortrait: (
    nodeId: string,
    options?: NodePortraitRequestOptions,
  ) => Promise<NodePortraitResult>;
  planAgentProfileUpdate: (
    nodeId: string,
    input: AgentProfileUpdateInput,
  ) => Promise<unknown>;
  applyAgentProfileUpdate: (
    nodeId: string,
    input: ApplyAgentProfileUpdateInput,
  ) => Promise<unknown>;
  listAgentsConfigSnapshots: (nodeId: string) => Promise<unknown>;
  rollbackAgentsConfig: (
    nodeId: string,
    input: RollbackAgentsConfigInput,
  ) => Promise<unknown>;
  previewAgentContext: (
    nodeId: string,
    input: AgentContextPreviewInput,
    options?: NodePortraitRequestOptions,
  ) => Promise<unknown>;
};

export type NodeAgentProfileRouteOptions = {
  provider: NodeAgentProfileProvider;
  modelPresetProvider?: Pick<ModelPresetAvailabilityService, "listForNode">;
};

export class NodeAgentProfileRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "NodeAgentProfileRouteError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

type NodeParams = {
  node_id: string;
};

type AgentParams = NodeParams & {
  agent_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export const nodeAgentProfileRouteAuthRequirements = {
  "GET /api/nodes/:node_id/agents": true,
  "GET /api/nodes/:node_id/model-presets": true,
  "GET /api/nodes/:node_id/agents/:agent_id/portrait": true,
  "POST /api/nodes/:node_id/agents/config/plan-profile-update": true,
  "POST /api/nodes/:node_id/agents/config/apply-profile-update": true,
  "GET /api/nodes/:node_id/agents/config/snapshots": true,
  "POST /api/nodes/:node_id/agents/config/rollback": true,
  "POST /api/nodes/:node_id/agents/context-preview": true,
  "GET /api/nodes/:node_id/oauth-profiles": true,
  "GET /api/nodes/:node_id/user/portrait": true,
} as const;

export function registerNodeAgentProfileRoutes(
  app: FastifyInstance,
  options: NodeAgentProfileRouteOptions,
): void {
  app.get<{ Params: NodeParams }>("/api/nodes/:node_id/agents", async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "agents", nodeParams(request).node_id, undefined);
      return reply.code(result.status).send(result.body);
    });

  if (options.modelPresetProvider) {
    app.get<{ Params: NodeParams }>(
      "/api/nodes/:node_id/model-presets",
      async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "model-presets", nodeParams(request).node_id, undefined);
      return reply.code(result.status).send(result.body);
    },
    );
  }

  app.post<{ Params: NodeParams }>(
    "/api/nodes/:node_id/agents/config/plan-profile-update",
    async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "plan", nodeParams(request).node_id, request.body);
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: NodeParams }>(
    "/api/nodes/:node_id/agents/context-preview",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return validationError(reply, body);
      const input = contextPreviewInput(body.value);
      if (!input.ok) return validationError(reply, input);
      try {
        return reply.send(await options.provider.previewAgentContext(
          nodeParams(request).node_id,
          input.value,
          { headers: request.headers },
        ));
      } catch (error) {
        return sendConfigProviderError(reply, error);
      }
    },
  );

  app.post<{ Params: NodeParams }>(
    "/api/nodes/:node_id/agents/config/apply-profile-update",
    async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "apply", nodeParams(request).node_id, request.body);
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/agents/config/snapshots",
    async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "snapshots", nodeParams(request).node_id, undefined);
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: NodeParams }>(
    "/api/nodes/:node_id/agents/config/rollback",
    async (request, reply) => {
      const result = await executeNodeAgentProfileRoute(options, "rollback", nodeParams(request).node_id, request.body);
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: NodeParams }>("/api/nodes/:node_id/oauth-profiles", async (request, reply) =>
    deprecatedOauthProfiles(reply, nodeParams(request).node_id),
  );

  app.get<{ Params: NodeParams }>(
    "/api/nodes/:node_id/user/portrait",
    async (request, reply) => {
      try {
        return sendPortraitResult(
          reply,
          await options.provider.getUserPortrait(nodeParams(request).node_id, {
            headers: request.headers,
          }),
        );
      } catch {
        return reply.code(204).send();
      }
    },
  );

  app.get<{ Params: AgentParams }>(
    "/api/nodes/:node_id/agents/:agent_id/portrait",
    async (request, reply) => {
      const params = agentParams(request);
      try {
        return sendPortraitResult(
          reply,
          await options.provider.getAgentPortrait(params.node_id, params.agent_id, {
            headers: request.headers,
          }),
        );
      } catch {
        return reply.code(204).send();
      }
    },
  );
}

export async function executeNodeAgentProfileRoute(
  options: NodeAgentProfileRouteOptions,
  operation: "agents" | "model-presets" | "plan" | "apply" | "snapshots" | "rollback",
  nodeId: string,
  input?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (operation === "agents") {
    const profiles = await options.provider.listAgentProfiles(nodeId);
    return profiles === undefined ? { status: 404, body: { detail: `Node ${nodeId} not connected` } }
      : { status: 200, body: { agents: Object.entries(profiles).map(([id, profile]) => projectAgentProfile(nodeId, id, profile)) } };
  }
  if (operation === "model-presets") {
    const presets = options.modelPresetProvider?.listForNode(nodeId);
    return !presets ? { status: 404, body: { detail: `Node ${nodeId} not connected` } }
      : { status: 200, body: { model_presets: presets } };
  }
  const body = parseObjectBody(input);
  const parsed = !body.ok ? body : operation === "plan" ? profileUpdateInput(body.value)
    : operation === "apply" ? applyProfileUpdateInput(body.value)
    : operation === "rollback" ? rollbackInput(body.value) : { ok: true as const, value: {} };
  if (!parsed.ok) return { status: parsed.statusCode ?? 400, body: { error: { code: "INVALID_NODE_AGENT_PROFILE_REQUEST", message: parsed.message } } };
  try {
    const result = operation === "plan" ? await options.provider.planAgentProfileUpdate(nodeId, parsed.value as AgentProfileUpdateInput)
      : operation === "apply" ? await options.provider.applyAgentProfileUpdate(nodeId, parsed.value as ApplyAgentProfileUpdateInput)
      : operation === "rollback" ? await options.provider.rollbackAgentsConfig(nodeId, parsed.value as RollbackAgentsConfigInput)
      : await options.provider.listAgentsConfigSnapshots(nodeId);
    return { status: 200, body: result };
  } catch (error) {
    if (error instanceof NodeAgentProfileRouteError) return { status: error.statusCode, body: { error: {
      code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}),
    } } };
    return { status: 400, body: { error: { code: "NODE_AGENT_PROFILE_ROUTE_ERROR", message: error instanceof Error ? error.message : "Node profile route failed" } } };
  }
}

function projectAgentProfile(
  nodeId: string,
  agentId: string,
  profile: RawNodeAgentProfile,
): Record<string, unknown> {
  return {
    id: agentId,
    name: profile.name ?? null,
    portraitUrl: profile.portrait_url
      ? `/api/nodes/${nodeId}/agents/${agentId}/portrait`
      : "",
    max_turns: profile.max_turns ?? null,
    backend: profile.backend ?? "claude",
    ...(typeof profile.default_preset === "string"
      ? { default_preset: profile.default_preset }
      : {}),
  };
}

function sendPortraitResult(
  reply: FastifyReply,
  result: NodePortraitResult,
): FastifyReply {
  switch (result.status) {
    case "missing":
    case "requestFailure":
      return reply.code(204).send();
    case "upstream": {
      if (result.statusCode !== 200) {
        if (result.statusCode === 404) return reply.code(204).send();
        return reply.code(result.statusCode).send();
      }
      const body = decodePortraitBody(result.body ?? "", result.encoding);
      return reply
        .header("Cache-Control", "public, max-age=3600")
        .type(result.contentType ?? detectPortraitMime(body))
        .send(body);
    }
    case "cached": {
      const body = decodePortraitBody(result.body, result.encoding);
      return reply
        .header("Cache-Control", "public, max-age=3600")
        .type(detectPortraitMime(body))
        .send(body);
    }
  }

  function decodePortraitBody(body: PortraitBody, encoding?: "base64"): Buffer {
    if (typeof body === "string" && encoding === "base64") {
      return Buffer.from(body, "base64");
    }
    if (typeof body === "string") return Buffer.from(body);
    if (Buffer.isBuffer(body)) return body;
    return Buffer.from(body);
  }
}

function detectPortraitMime(data: Buffer): string {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return "image/png";
  }
  if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    return "image/jpeg";
  }
  if (
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.subarray(0, 4).toString() === "GIF8") return "image/gif";
  return "application/octet-stream";
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function profileUpdateInput(
  body: Record<string, unknown>,
): Validation<AgentProfileUpdateInput> {
  const profile = requiredObject(body, "profile");
  if (!profile.ok) return profile;
  const createIfMissing = optionalBooleanAlias(
    body,
    "create_if_missing",
    "createIfMissing",
  );
  if (!createIfMissing.ok) return createIfMissing;
  const includeTextDiff = optionalBooleanAlias(
    body,
    "include_text_diff",
    "includeTextDiff",
  );
  if (!includeTextDiff.ok) return includeTextDiff;
  return {
    ok: true,
    value: {
      profile: profile.value,
      createIfMissing: createIfMissing.value,
      includeTextDiff: includeTextDiff.value,
    },
  };
}

function applyProfileUpdateInput(
  body: Record<string, unknown>,
): Validation<ApplyAgentProfileUpdateInput> {
  const base = profileUpdateInput(body);
  if (!base.ok) return base;
  const expectedConfigChecksum = optionalStringAlias(
    body,
    "expected_config_checksum",
    "expectedConfigChecksum",
  );
  if (!expectedConfigChecksum.ok) return expectedConfigChecksum;
  return {
    ok: true,
    value: {
      ...base.value,
      expectedConfigChecksum: expectedConfigChecksum.value,
    },
  };
}

function rollbackInput(
  body: Record<string, unknown>,
): Validation<RollbackAgentsConfigInput> {
  const snapshotPath = optionalStringAlias(body, "snapshot_path", "snapshotPath");
  if (!snapshotPath.ok) return snapshotPath;
  const snapshotId = optionalStringAlias(body, "snapshot_id", "snapshotId");
  if (!snapshotId.ok) return snapshotId;
  if (!snapshotPath.value && !snapshotId.value) {
    return {
      ok: false,
      message: "snapshot_path or snapshot_id is required",
      statusCode: 422,
    };
  }
  const includeTextDiff = optionalBooleanAlias(
    body,
    "include_text_diff",
    "includeTextDiff",
  );
  if (!includeTextDiff.ok) return includeTextDiff;
  return {
    ok: true,
    value: {
      snapshotPath: snapshotPath.value,
      snapshotId: snapshotId.value,
      includeTextDiff: includeTextDiff.value,
    },
  };
}

function contextPreviewInput(
  body: Record<string, unknown>,
): Validation<AgentContextPreviewInput> {
  if (!Array.isArray(body.atom_contexts)) {
    return { ok: false, message: "atom_contexts must be an array", statusCode: 422 };
  }
  if (body.session !== undefined && (
    typeof body.session !== "object" || body.session === null || Array.isArray(body.session)
  )) {
    return { ok: false, message: "session must be an object", statusCode: 422 };
  }
  return {
    ok: true,
    value: {
      atom_contexts: body.atom_contexts,
      ...(body.session ? { session: body.session as Record<string, unknown> } : {}),
    },
  };
}

function requiredObject(
  body: Record<string, unknown>,
  key: string,
): Validation<Record<string, unknown>> {
  const value = body[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  return { ok: false, message: `${key} must be an object` };
}

function optionalBooleanAlias(
  body: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): Validation<boolean> {
  const value = hasOwn(body, snakeKey) ? body[snakeKey] : body[camelKey];
  if (value === undefined) return { ok: true, value: false };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false, message: `${snakeKey} must be a boolean` };
}

function optionalStringAlias(
  body: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): Validation<string | null | undefined> {
  const value = hasOwn(body, snakeKey) ? body[snakeKey] : body[camelKey];
  if (value === undefined || value === null || typeof value === "string") {
    return { ok: true, value };
  }
  return { ok: false, message: `${snakeKey} must be a string or null` };
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({
    error: {
      code: "INVALID_NODE_AGENT_PROFILE_REQUEST",
      message: validation.message,
    },
  });
}

function sendConfigProviderError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof NodeAgentProfileRouteError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }
  const message = error instanceof Error ? error.message : "Node profile route failed";
  return reply.code(400).send({
    error: {
      code: "NODE_AGENT_PROFILE_ROUTE_ERROR",
      message,
    },
  });
}

function deprecatedOauthProfiles(reply: FastifyReply, nodeId: string): FastifyReply {
  const deprecatedPath = `/api/nodes/${nodeId}/oauth-profiles`;
  const replacementPath = `/api/nodes/${nodeId}/claude-auth/profiles`;
  return reply
    .code(410)
    .headers({
      "X-Soulstream-Deprecated-Path": deprecatedPath,
      "X-Soulstream-Replacement-Path": replacementPath,
      "X-Soulstream-Desktop-Action": "hard-reload",
      "Cache-Control": "no-store",
    })
    .send({
      error: {
        code: "DEPRECATED_API_PATH",
        message:
          "Deprecated API path. Refresh the dashboard bundle and use " +
          `GET ${replacementPath}.`,
        deprecatedPath,
        replacementPath,
        replacementMethod: "GET",
        desktopAction: "hard-reload",
      },
    });
}

function nodeParams(request: FastifyRequest): NodeParams {
  return request.params as NodeParams;
}

function agentParams(request: FastifyRequest): AgentParams {
  return request.params as AgentParams;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
