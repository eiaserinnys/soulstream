import type { IncomingHttpHeaders } from "node:http";
import { type as getOsType } from "node:os";

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

import { AgentAtomContextSchema } from "../agent_registry.js";
import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type { AtomFetchConfig, AtomContextSpec } from "./atom_context.js";
import { hostOsConditionValue } from "./host_os.js";
import {
  compileContexts,
  type ContextFilterParameters,
} from "./compiler/index.js";

export interface ContextPreviewRouteConfig {
  nodeId: string;
  atom: AtomFetchConfig;
  auth: BoardYjsAuthConfig;
  logger: Pick<Logger, "warn">;
}

interface PreviewBody {
  atom_contexts?: unknown;
  session?: unknown;
}

export function registerContextPreviewRoute(
  fastify: FastifyInstance,
  config: ContextPreviewRouteConfig,
): void {
  fastify.post<{ Body: PreviewBody }>("/api/context/preview", async (request, reply) => {
    const unauthorized = await authorize(request.headers, config.auth);
    if (unauthorized) return reply.status(401).send({ detail: unauthorized });

    const parsed = parsePreviewBody(request.body, config.nodeId);
    if (!parsed.ok) return reply.status(422).send({ detail: parsed.error });

    const compilation = await compileContexts(
      config.atom,
      parsed.value.specs,
      config.logger,
      parsed.value.parameters,
    );
    return reply.send({ manifest: compilation.manifest });
  });
}

type PreviewParseResult =
  | { ok: true; value: { specs: AtomContextSpec[]; parameters: ContextFilterParameters } }
  | { ok: false; error: string };

function parsePreviewBody(body: PreviewBody | undefined, nodeId: string): PreviewParseResult {
  if (!body || !Array.isArray(body.atom_contexts)) {
    return { ok: false, error: "atom_contexts must be an array" };
  }
  const specs: AtomContextSpec[] = [];
  for (const raw of body.atom_contexts) {
    const parsed = AgentAtomContextSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "atom_contexts is invalid" };
    }
    specs.push({
      nodeId: parsed.data.node_id,
      depth: parsed.data.depth,
      titlesOnly: parsed.data.titles_only,
      ...(parsed.data.include_ids !== undefined ? { includeIds: parsed.data.include_ids } : {}),
      ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.applies_when !== undefined ? { appliesWhen: parsed.data.applies_when } : {}),
    });
  }
  const session = isRecord(body.session) ? body.session : {};
  const parameters: ContextFilterParameters = {
    node_id: nodeId,
    ...(nonEmptyString(session.source) ? { source: session.source as string } : {}),
    ...(nonEmptyString(session.folder_id)
      ? { folder_id: session.folder_id as string }
      : {}),
    ...(nonEmptyString(session.agent) ? { agent: session.agent as string } : {}),
    ...(nonEmptyString(session.backend) ? { backend: session.backend as string } : {}),
    ...(nonEmptyString(session.card_role) ? { card_role: session.card_role as string } : {}),
    os: hostOsConditionValue(getOsType()),
  };
  return { ok: true, value: { specs, parameters } };
}

async function authorize(
  headers: IncomingHttpHeaders,
  auth: BoardYjsAuthConfig,
): Promise<string | null> {
  try {
    await authenticateDashboardHttpRequest({ requestHeaders: headers, config: auth });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Authentication failed";
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
