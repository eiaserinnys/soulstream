import type { FastifyInstance, FastifyReply } from "fastify";

import type { AgentProfileRepository } from "./agent_profile_routes.js";
import { parseAtomContexts, type AgentAtomContext, type ParseResult } from "./atom_contexts.js";

export type ContextBundleRecord = {
  readonly bundleId: string;
  readonly description: string;
  readonly atomContexts: readonly AgentAtomContext[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ContextBundleWrite = {
  readonly bundleId: string;
  readonly description: string;
  readonly atomContexts: readonly AgentAtomContext[];
  readonly expectedVersion: number | null;
};

export type ContextBundleRepository = {
  readonly list: () => Promise<readonly ContextBundleRecord[]>;
  readonly get: (bundleId: string) => Promise<ContextBundleRecord | null>;
  readonly put: (input: ContextBundleWrite) => Promise<ContextBundleRecord>;
  readonly delete: (bundleId: string, expectedVersion: number) => Promise<boolean>;
};

export class ContextBundleVersionConflictError extends Error {
  constructor(readonly bundleId: string) {
    super(`Context bundle ${bundleId} changed`);
    this.name = "ContextBundleVersionConflictError";
  }
}

export type ContextBundleRouteOptions = {
  readonly repository: ContextBundleRepository;
  readonly profileRepository: Pick<AgentProfileRepository, "list">;
};

export const contextBundleRouteAuthRequirements = {
  "GET /api/context-bundles": true,
  "GET /api/context-bundles/:bundle_id": true,
  "PUT /api/context-bundles/:bundle_id": true,
  "DELETE /api/context-bundles/:bundle_id": true,
} as const;

type BundleParams = { bundle_id: string };

export function registerContextBundleRoutes(
  app: FastifyInstance,
  options: ContextBundleRouteOptions,
): void {
  app.get("/api/context-bundles", async (_request, reply) =>
    reply.send({ bundles: (await options.repository.list()).map(projectBundle) }));

  app.get<{ Params: BundleParams }>("/api/context-bundles/:bundle_id", async (request, reply) => {
    const bundleId = parseBundleId(request.params.bundle_id);
    if (!bundleId.ok) return reply.code(422).send({ detail: bundleId.error });
    const bundle = await options.repository.get(bundleId.value);
    return bundle === null
      ? reply.code(404).send({ detail: "Context bundle not found" })
      : reply.send(projectBundle(bundle));
  });

  app.put<{ Params: BundleParams }>("/api/context-bundles/:bundle_id", async (request, reply) => {
    const bundleId = parseBundleId(request.params.bundle_id);
    if (!bundleId.ok) return reply.code(422).send({ detail: bundleId.error });
    const parsed = parseContextBundleWrite(bundleId.value, request.body);
    if (!parsed.ok) return reply.code(422).send({ detail: parsed.error });
    try {
      return reply.send(projectBundle(await options.repository.put(parsed.value)));
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });

  app.delete<{ Params: BundleParams }>("/api/context-bundles/:bundle_id", async (request, reply) => {
    const bundleId = parseBundleId(request.params.bundle_id);
    if (!bundleId.ok) return reply.code(422).send({ detail: bundleId.error });
    const version = expectedVersion(request.body);
    if (!version.ok) return reply.code(422).send({ detail: version.error });

    const referencedBy = (await options.profileRepository.list())
      .filter((profile) => profile.contextBundles.includes(bundleId.value))
      .map((profile) => profile.agentId)
      .sort((left, right) => left.localeCompare(right));
    if (referencedBy.length > 0) {
      return reply.code(409).send({
        detail: "Context bundle is referenced by agent profiles",
        referenced_by: referencedBy,
      });
    }

    try {
      const deleted = await options.repository.delete(bundleId.value, version.value);
      return deleted
        ? reply.code(204).send()
        : reply.code(404).send({ detail: "Context bundle not found" });
    } catch (error) {
      return sendRepositoryError(reply, error);
    }
  });
}

function parseContextBundleWrite(bundleId: string, body: unknown): ParseResult<ContextBundleWrite> {
  if (!isObject(body)) return invalid("Request body must be an object");
  if (body.description !== undefined && typeof body.description !== "string") {
    return invalid("description must be a string");
  }
  const contexts = parseAtomContexts(body.atom_contexts);
  if (!contexts.ok) return contexts;
  const version = nullableExpectedVersion(body.expected_version);
  if (!version.ok) return version;
  return {
    ok: true,
    value: {
      bundleId,
      description: typeof body.description === "string" ? body.description : "",
      atomContexts: contexts.value,
      expectedVersion: version.value,
    },
  };
}

function parseBundleId(value: string): ParseResult<string> {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? { ok: true, value }
    : invalid("bundle_id format is invalid");
}

function projectBundle(bundle: ContextBundleRecord): Record<string, unknown> {
  return {
    bundle_id: bundle.bundleId,
    description: bundle.description,
    atom_contexts: bundle.atomContexts,
    version: bundle.version,
    created_at: bundle.createdAt,
    updated_at: bundle.updatedAt,
  };
}

function expectedVersion(body: unknown): ParseResult<number> {
  return isObject(body) ? positiveInteger(body.expected_version, "expected_version") : invalid("expected_version is required");
}

function nullableExpectedVersion(value: unknown): ParseResult<number | null> {
  if (value === null) return { ok: true, value: null };
  return positiveInteger(value, "expected_version");
}

function positiveInteger(value: unknown, name: string): ParseResult<number> {
  return Number.isInteger(value) && (value as number) > 0
    ? { ok: true, value: value as number }
    : invalid(`${name} must be a positive integer`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function sendRepositoryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ContextBundleVersionConflictError) {
    return reply.code(409).send({ detail: error.message, code: "context_bundle_version_conflict" });
  }
  throw error;
}
