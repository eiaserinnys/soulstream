import type { IncomingHttpHeaders } from "node:http";
import { type as getOsType } from "node:os";

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import { AgentAtomContextSchema, type AgentProfile } from "@soulstream/agent-profile-contract";
import { isRecord } from "@soulstream/wire-schema/json-record";
import type { NewSessionAgentProfileSource } from "../agent_profile_source.js";
import {
  authenticateDashboardHttpRequest,
  type DashboardHttpAuthConfig,
} from "./dashboard_http_auth.js";
import { formatAtomMarkdown, type AtomFetchConfig, type AtomContextSpec } from "./atom_context.js";
import { extractAgentAtomContextSpecs, prioritizeAtomContextSpecs } from "./context_builder_helpers.js";
import { fetchAtomNodeTitle } from "./compiler/render_modes.js";
import { fetchAtomParentTitle } from "./compiler/parent_title.js";
import { hostOsConditionValue } from "./host_os.js";
import {
  compileContexts,
  type ContextFilterParameters,
} from "./compiler/index.js";

export interface ContextPreviewRouteConfig {
  nodeId: string;
  atom: AtomFetchConfig;
  auth: DashboardHttpAuthConfig;
  logger: Pick<Logger, "warn">;
  agentRegistry?: Pick<AgentRegistry, "get">;
  agentProfileSource?: Pick<NewSessionAgentProfileSource, "resolve">;
}

interface PreviewBody {
  atom_contexts?: unknown;
  agent_id?: unknown;
  session?: unknown;
  ignore_conditions?: unknown;
  summary_only?: unknown;
}

export function registerContextPreviewRoute(
  fastify: FastifyInstance,
  config: ContextPreviewRouteConfig,
): void {
  fastify.post<{ Body: PreviewBody }>("/api/context/preview", async (request, reply) => {
    const unauthorized = await authorize(request.headers, config.auth);
    if (unauthorized) return reply.status(401).send({ detail: unauthorized });

    const parsed = await parsePreviewBody(request.body, config);
    if (!parsed.ok) return reply.status(parsed.status).send({ detail: parsed.error });

    const specs = parsed.value.specs;
    const selected = prioritizeAtomContextSpecs({ session: [], pageNodeIds: [], folder: [], agent: specs }).agent;
    const nodeIds = [...new Set(selected.map((spec) => spec.nodeId))];
    const titles = new Map(await Promise.all(nodeIds.map(async (nodeId) => [
      nodeId, await fetchAtomNodeTitle(config.atom, nodeId, config.logger),
    ] as const)));
    const parentTitles = new Map(await Promise.all(nodeIds.map(async (nodeId) => [
      nodeId, await fetchAtomParentTitle(config.atom, nodeId, config.logger),
    ] as const)));
    const compilation = await compileContexts(
      config.atom,
      selected,
      config.logger,
      parsed.value.parameters,
      { ignoreConditions: parsed.value.ignoreConditions },
    );
    const summaryOnly = parsed.value.summaryOnly;
    return reply.send({
      manifest: {
        ...compilation.manifest,
        sources: compilation.manifest.sources.map((source, index) => ({
          ...source,
          title: titles.get(source.node_id) ?? null,
          parent_title: parentTitles.get(source.node_id) ?? null,
          documents: compilation.sections[index]?.documents ?? [],
        })),
      },
      assembled: summaryOnly ? "" : compilation.assembled,
      sections: compilation.sections.map((section, index) => ({
        spec_index: specs.indexOf(selected[index]!),
        title: titles.get(section.source.nodeId) ?? null,
        markdown: summaryOnly
          ? ""
          : section.markdown === null ? null : formatAtomMarkdown(section.markdown),
      })),
      atom_base_url: config.atom.enabled && config.atom.serverUrl
        ? config.atom.serverUrl.replace(/\/+$/, "") : null,
    });
  });
}

type PreviewParseResult =
  | {
    ok: true;
    value: {
      specs: AtomContextSpec[];
      parameters: ContextFilterParameters;
      ignoreConditions: boolean;
      summaryOnly: boolean;
    };
  }
  | { ok: false; status: 404 | 422; error: string };

async function parsePreviewBody(body: PreviewBody | undefined, config: ContextPreviewRouteConfig): Promise<PreviewParseResult> {
  if (!body || (body.atom_contexts !== undefined) === (body.agent_id !== undefined)) {
    return { ok: false, status: 422, error: "provide exactly one of atom_contexts or agent_id" };
  }
  for (const flag of ["ignore_conditions", "summary_only"] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
      return { ok: false, status: 422, error: `${flag} must be a boolean` };
    }
  }
  const specs: AtomContextSpec[] = [];
  let profile: AgentProfile | undefined;
  if (body.agent_id !== undefined) {
    if (!nonEmptyString(body.agent_id)) return { ok: false, status: 422, error: "agent_id must be a non-empty string" };
    profile = config.agentProfileSource
      ? (await config.agentProfileSource.resolve(body.agent_id))?.profile
      : config.agentRegistry?.get(body.agent_id);
    if (!profile) return { ok: false, status: 404, error: `Unknown agent profile: ${body.agent_id}` };
    specs.push(...extractAgentAtomContextSpecs(profile));
  } else {
    if (!Array.isArray(body.atom_contexts)) return { ok: false, status: 422, error: "atom_contexts must be an array" };
    for (const raw of body.atom_contexts) {
      const parsed = AgentAtomContextSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, status: 422, error: parsed.error.issues[0]?.message ?? "atom_contexts is invalid" };
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
  }
  const session = isRecord(body.session) ? body.session : {};
  const parameters: ContextFilterParameters = {
    node_id: config.nodeId,
    ...(nonEmptyString(session.source) ? { source: session.source as string } : {}),
    ...(nonEmptyString(session.folder_id)
      ? { folder_id: session.folder_id as string }
      : {}),
    ...(profile ? { agent: profile.id } : nonEmptyString(session.agent) ? { agent: session.agent } : {}),
    ...(nonEmptyString(session.backend) ? { backend: session.backend as string } : {}),
    ...(nonEmptyString(session.card_role) ? { card_role: session.card_role as string } : {}),
    os: hostOsConditionValue(getOsType()),
  };
  return {
    ok: true,
    value: {
      specs,
      parameters,
      ignoreConditions: body.ignore_conditions === true,
      summaryOnly: body.summary_only === true,
    },
  };
}

async function authorize(
  headers: IncomingHttpHeaders,
  auth: DashboardHttpAuthConfig,
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
