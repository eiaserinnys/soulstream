import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type AgentAtomContext = {
  readonly node_id: string;
  readonly depth?: number;
  readonly titles_only?: boolean;
  readonly include_ids?: boolean;
  readonly mode?: "full" | "index" | "titles";
  readonly applies_when?: Readonly<Record<string, unknown>>;
};

export type AgentAlias = string | {
  readonly id: string;
  readonly default_preset?: string;
};

export type AgentProfileRecord = {
  readonly agentId: string;
  readonly name: string;
  readonly atomContexts: readonly AgentAtomContext[];
  readonly defaultPreset: string | null;
  readonly aliases: readonly AgentAlias[];
  readonly hasPortrait: boolean;
  readonly portrait: {
    readonly mime: SupportedPortraitMime;
    readonly size: number;
    readonly sha256: string;
  } | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AgentPortraitRecord = {
  readonly body: Buffer;
  readonly mime: SupportedPortraitMime;
  readonly sha256: string;
  readonly version: number;
};

export type AgentProfileWrite = {
  readonly agentId: string;
  readonly name: string;
  readonly atomContexts: readonly AgentAtomContext[];
  readonly defaultPreset: string | null;
  readonly aliases: readonly AgentAlias[];
  readonly expectedVersion: number | null;
};

export type AgentPortraitWrite = {
  readonly agentId: string;
  readonly body: Buffer;
  readonly mime: SupportedPortraitMime;
  readonly sha256: string;
  readonly expectedVersion: number;
};

export type AgentProfileRepository = {
  readonly snapshot: () => readonly AgentProfileRecord[];
  readonly list: () => Promise<readonly AgentProfileRecord[]>;
  readonly get: (agentId: string) => Promise<AgentProfileRecord | null>;
  readonly put: (input: AgentProfileWrite) => Promise<AgentProfileRecord>;
  readonly delete: (agentId: string, expectedVersion: number) => Promise<boolean>;
  readonly getPortrait: (agentId: string) => Promise<AgentPortraitRecord | null>;
  readonly putPortrait: (input: AgentPortraitWrite) => Promise<AgentProfileRecord>;
  readonly deletePortrait: (
    agentId: string,
    expectedVersion: number,
  ) => Promise<AgentProfileRecord | null>;
};

export class AgentProfileVersionConflictError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent profile ${agentId} changed`);
    this.name = "AgentProfileVersionConflictError";
  }
}

export type AgentProfileRouteOptions = {
  readonly repository: AgentProfileRepository;
};

export const supportedPortraitMimes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type SupportedPortraitMime = (typeof supportedPortraitMimes)[number];

export const agentProfileRouteAuthRequirements = {
  "GET /api/agent-profiles": true,
  "GET /api/agent-profiles/runtime": true,
  "GET /api/agent-profiles/:agent_id": true,
  "PUT /api/agent-profiles/:agent_id": true,
  "DELETE /api/agent-profiles/:agent_id": true,
  "GET /api/agent-profiles/:agent_id/portrait": true,
  "PUT /api/agent-profiles/:agent_id/portrait": true,
  "DELETE /api/agent-profiles/:agent_id/portrait": true,
} as const;

type AgentParams = { agent_id: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerAgentProfileRoutes(
  app: FastifyInstance,
  options: AgentProfileRouteOptions,
): void {
  app.get("/api/agent-profiles", async (_request, reply) =>
    reply.send({ profiles: (await options.repository.list()).map(projectProfile) }));

  app.get("/api/agent-profiles/runtime", async (_request, reply) =>
    reply.send({ profiles: (await options.repository.list()).map(projectRuntimeProfile) }));

  app.get<{ Params: AgentParams }>("/api/agent-profiles/:agent_id", async (request, reply) => {
    const profile = await options.repository.get(agentId(request));
    return profile === null
      ? reply.code(404).send({ detail: "Agent profile not found" })
      : reply.send(projectProfile(profile));
  });

  app.put<{ Params: AgentParams }>("/api/agent-profiles/:agent_id", async (request, reply) => {
    const parsed = parseProfileWrite(agentId(request), request.body);
    if (!parsed.ok) return reply.code(422).send({ detail: parsed.error });
    try {
      return reply.send(projectProfile(await options.repository.put(parsed.value)));
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });

  app.delete<{ Params: AgentParams }>("/api/agent-profiles/:agent_id", async (request, reply) => {
    const version = expectedVersion(request.body);
    if (!version.ok) return reply.code(422).send({ detail: version.error });
    try {
      const deleted = await options.repository.delete(agentId(request), version.value);
      return deleted ? reply.code(204).send() : reply.code(404).send({ detail: "Agent profile not found" });
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });

  app.get<{ Params: AgentParams }>("/api/agent-profiles/:agent_id/portrait", async (request, reply) => {
    const portrait = await options.repository.getPortrait(agentId(request));
    if (portrait === null) return reply.code(204).send();
    return reply
      .header("Cache-Control", "public, max-age=3600")
      .header("ETag", `\"${portrait.sha256}\"`)
      .type(portrait.mime)
      .send(portrait.body);
  });

  app.put<{ Params: AgentParams }>("/api/agent-profiles/:agent_id/portrait", async (request, reply) => {
    const parsed = parsePortraitWrite(agentId(request), request.body);
    if (!parsed.ok) return reply.code(422).send({ detail: parsed.error });
    try {
      return reply.send(projectProfile(await options.repository.putPortrait(parsed.value)));
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });

  app.delete<{ Params: AgentParams }>("/api/agent-profiles/:agent_id/portrait", async (request, reply) => {
    const version = expectedVersion(request.body);
    if (!version.ok) return reply.code(422).send({ detail: version.error });
    try {
      const profile = await options.repository.deletePortrait(agentId(request), version.value);
      return profile === null
        ? reply.code(404).send({ detail: "Agent profile not found" })
        : reply.send(projectProfile(profile));
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });
}

function agentId(request: FastifyRequest<{ Params: AgentParams }>): string {
  return request.params.agent_id;
}

function projectProfile(profile: AgentProfileRecord): Record<string, unknown> {
  return {
    agent_id: profile.agentId,
    name: profile.name,
    atom_contexts: profile.atomContexts,
    default_preset: profile.defaultPreset,
    aliases: profile.aliases,
    has_portrait: profile.hasPortrait,
    portrait: profile.portrait,
    version: profile.version,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

function projectRuntimeProfile(profile: AgentProfileRecord): Record<string, unknown> {
  const projected = projectProfile(profile);
  delete projected.created_at;
  return projected;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseProfileWrite(agentIdValue: string, body: unknown): ParseResult<AgentProfileWrite> {
  if (!isObject(body)) return invalid("Request body must be an object");
  if (typeof body.name !== "string" || body.name.length === 0) return invalid("name is required");
  const contexts = parseAtomContexts(body.atom_contexts);
  if (!contexts.ok) return contexts;
  const aliases = parseAliases(body.aliases);
  if (!aliases.ok) return aliases;
  if (body.default_preset !== null && body.default_preset !== undefined && typeof body.default_preset !== "string") {
    return invalid("default_preset must be a string or null");
  }
  const version = nullableExpectedVersion(body.expected_version);
  if (!version.ok) return version;
  return { ok: true, value: {
    agentId: agentIdValue,
    name: body.name,
    atomContexts: contexts.value,
    defaultPreset: typeof body.default_preset === "string" ? body.default_preset : null,
    aliases: aliases.value,
    expectedVersion: version.value,
  } };
}

function parsePortraitWrite(agentIdValue: string, body: unknown): ParseResult<AgentPortraitWrite> {
  if (!isObject(body)) return invalid("Request body must be an object");
  if (typeof body.data_base64 !== "string" || body.data_base64.length === 0) return invalid("data_base64 is required");
  if (!supportedPortraitMimes.includes(body.mime as SupportedPortraitMime)) return invalid("mime is not supported");
  const version = positiveInteger(body.expected_version, "expected_version");
  if (!version.ok) return version;
  const decoded = Buffer.from(body.data_base64, "base64");
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== body.data_base64.replace(/=+$/, "")) {
    return invalid("data_base64 is invalid");
  }
  const mime = body.mime as SupportedPortraitMime;
  if (detectPortraitMime(decoded) !== mime) return invalid("mime does not match portrait bytes");
  const sha256 = createHash("sha256").update(decoded).digest("hex");
  if (body.sha256 !== undefined && body.sha256 !== sha256) return invalid("sha256 does not match portrait bytes");
  return { ok: true, value: { agentId: agentIdValue, body: decoded, mime, sha256, expectedVersion: version.value } };
}

function parseAtomContexts(value: unknown): ParseResult<AgentAtomContext[]> {
  if (!Array.isArray(value)) return invalid("atom_contexts must be an array");
  const result: AgentAtomContext[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.node_id !== "string" || !UUID_RE.test(entry.node_id)) return invalid("atom_contexts node_id must be a UUID");
    if (entry.depth !== undefined && (!Number.isInteger(entry.depth) || (entry.depth as number) < 0)) return invalid("atom_contexts depth must be a non-negative integer");
    if (entry.mode !== undefined && !["full", "index", "titles"].includes(String(entry.mode))) return invalid("atom_contexts mode is invalid");
    if (entry.titles_only !== undefined && typeof entry.titles_only !== "boolean") return invalid("atom_contexts titles_only must be boolean");
    if (entry.include_ids !== undefined && typeof entry.include_ids !== "boolean") return invalid("atom_contexts include_ids must be boolean");
    if (entry.applies_when !== undefined && !isObject(entry.applies_when)) return invalid("atom_contexts applies_when must be an object");
    result.push({ node_id: entry.node_id, ...(typeof entry.depth === "number" ? { depth: entry.depth } : {}), ...(typeof entry.titles_only === "boolean" ? { titles_only: entry.titles_only } : {}), ...(typeof entry.include_ids === "boolean" ? { include_ids: entry.include_ids } : {}), ...(typeof entry.mode === "string" ? { mode: entry.mode as AgentAtomContext["mode"] } : {}), ...(isObject(entry.applies_when) ? { applies_when: entry.applies_when } : {}) });
  }
  return { ok: true, value: result };
}

function expectedVersion(body: unknown): ParseResult<number> {
  return isObject(body) ? positiveInteger(body.expected_version, "expected_version") : invalid("expected_version is required");
}

function nullableExpectedVersion(value: unknown): ParseResult<number | null> {
  if (value === null) return { ok: true, value: null };
  return positiveInteger(value, "expected_version");
}

function positiveInteger(value: unknown, name: string): ParseResult<number> {
  return Number.isInteger(value) && (value as number) > 0 ? { ok: true, value: value as number } : invalid(`${name} must be a positive integer`);
}

function parseAliases(value: unknown): ParseResult<AgentAlias[]> {
  if (!Array.isArray(value)) return invalid("aliases must be an array");
  const aliases: AgentAlias[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const alias = typeof entry === "string"
      ? entry
      : isObject(entry) && typeof entry.id === "string"
        ? { id: entry.id, ...(typeof entry.default_preset === "string" ? { default_preset: entry.default_preset } : {}) }
        : null;
    const id = typeof alias === "string" ? alias : alias?.id;
    if (!alias || !id || ids.has(id)) return invalid("aliases must contain unique non-empty ids");
    ids.add(id);
    aliases.push(alias);
  }
  return { ok: true, value: aliases };
}

function detectPortraitMime(data: Buffer): SupportedPortraitMime | null {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return "image/jpeg";
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (data.subarray(0, 4).toString() === "GIF8") return "image/gif";
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function sendRepositoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentProfileVersionConflictError) {
    return reply.code(409).send({ detail: error.message, code: "agent_profile_version_conflict" });
  }
  throw error;
}
