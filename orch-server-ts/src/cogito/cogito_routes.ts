import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AGGREGATE_SCHEMA_VERSION = "soulstream.reflect.aggregate.v1";
export const DEFAULT_BRIEF_TIMEOUT_SECONDS = 5;

export type CogitoNode = {
  id: string;
  host: string;
  port: number;
  capabilities?: Record<string, unknown>;
};

export type CogitoNodeProvider = {
  listConnectedNodes: () => CogitoNode[] | Promise<CogitoNode[]>;
};

export type CogitoSearchParams = {
  q: string;
  top_k: number;
  search_session_id: boolean;
  include_turn_summaries: boolean;
  include_highlight: boolean;
  include_story: boolean;
  event_types?: string;
  event_categories?: string;
};

export type CogitoSearchResult = Record<string, unknown>;
export type CogitoNavigationSearchResult = Record<string, unknown>;

export type CogitoSearchResponse = {
  results: CogitoSearchResult[];
  navigation_results: CogitoNavigationSearchResult[];
};

export type CogitoSearchProvider = {
  search: (params: CogitoSearchParams) => CogitoSearchResponse | Promise<CogitoSearchResponse>;
};

export type CogitoSearchSessionRecord = Record<string, unknown>;

export type CogitoSearchAccessFilter = {
  getSession: (
    sessionId: string,
  ) => CogitoSearchSessionRecord | null | undefined | Promise<CogitoSearchSessionRecord | null | undefined>;
  isFolderAllowed: (
    folderId: string | null | undefined,
    session: CogitoSearchSessionRecord,
  ) => boolean | Promise<boolean>;
};

export type CogitoSearchAccess = {
  restricted: boolean;
};

export type CogitoSearchAccessProvider = {
  resolveAccess: (request: FastifyRequest) => CogitoSearchAccess | Promise<CogitoSearchAccess>;
  filterResults?: (input: {
    request: FastifyRequest;
    response: CogitoSearchResponse;
  }) => CogitoSearchResponse | Promise<CogitoSearchResponse>;
};

export type CogitoBriefStatus = "ok" | "timeout" | "unavailable" | "error";

export type CogitoBriefNodeEntry = {
  node_id: string;
  status: CogitoBriefStatus;
  checked_at: string;
  source: ReturnType<typeof nodeSource>;
  data: Record<string, unknown> | null;
  errors: Array<{ code: string; message: string }>;
};

export type CogitoBriefAggregate = {
  schema_version: typeof AGGREGATE_SCHEMA_VERSION;
  kind: "orchestrator_node_brief_aggregate";
  status: "empty" | "ok" | "partial" | "error";
  generated_at: string;
  checked_at: string;
  source: ReturnType<typeof aggregateSource>;
  timeout_seconds: number;
  node_count: number;
  nodes: CogitoBriefNodeEntry[];
};

export type CogitoBriefCollector = {
  reflectBrief: (node: CogitoNode, timeoutSeconds: number) => Promise<unknown>;
};

export type CogitoRouteOptions = {
  provider: CogitoNodeProvider;
  searchProvider: CogitoSearchProvider;
  briefCollector: CogitoBriefCollector;
  accessProvider?: CogitoSearchAccessProvider;
  nowIso?: () => string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: number; detail: string };

export const cogitoRouteAuthRequirements = {
  "GET /cogito/search": true,
  "GET /cogito/briefs": true,
} as const;

export class CogitoBriefTimeoutError extends Error {}
export class CogitoBriefUnavailableError extends Error {}

export function registerCogitoRoutes(
  app: FastifyInstance,
  options: CogitoRouteOptions,
): void {
  app.get("/cogito/search", async (request, reply) => {
    const query = parseSearchQuery(request.query);
    if (!query.ok) return routeError(reply, query.statusCode, query.detail);

    const response = await options.searchProvider.search(query.value);
    const access = await resolveSearchAccess(options, request);
    return access.restricted
      ? await filterRestrictedResults(options, request, response)
      : response;
  });

  app.get("/cogito/briefs", async (request, reply) => {
    const timeout = parseBriefTimeout(request.query);
    if (!timeout.ok) return routeError(reply, timeout.statusCode, timeout.detail);
    const nodes = await options.provider.listConnectedNodes();
    return collectCogitoBriefs(nodes, {
      collector: options.briefCollector,
      timeoutSeconds: timeout.value,
      nowIso: options.nowIso ?? nowIso,
    });
  });
}

export async function collectCogitoBriefs(
  nodes: CogitoNode[],
  options: {
    collector: CogitoBriefCollector;
    timeoutSeconds?: number;
    nowIso?: () => string;
  },
): Promise<CogitoBriefAggregate> {
  const now = options.nowIso ?? nowIso;
  const checkedAt = now();
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_BRIEF_TIMEOUT_SECONDS;
  const targetNodes = nodes.filter(supportsReflectBrief);
  if (targetNodes.length === 0) {
    return {
      schema_version: AGGREGATE_SCHEMA_VERSION,
      kind: "orchestrator_node_brief_aggregate",
      status: "empty",
      generated_at: checkedAt,
      checked_at: checkedAt,
      source: aggregateSource(),
      timeout_seconds: timeoutSeconds,
      node_count: 0,
      nodes: [],
    };
  }

  const entries = await Promise.all(
    targetNodes.map((node) => collectSingleNodeBrief(node, options.collector, {
      timeoutSeconds,
      nowIso: now,
    })),
  );
  return {
    schema_version: AGGREGATE_SCHEMA_VERSION,
    kind: "orchestrator_node_brief_aggregate",
    status: aggregateStatus(entries),
    generated_at: checkedAt,
    checked_at: checkedAt,
    source: aggregateSource(),
    timeout_seconds: timeoutSeconds,
    node_count: entries.length,
    nodes: entries,
  };
}

export async function filterCogitoSearchResultsByAccess(
  results: CogitoSearchResult[],
  filter: CogitoSearchAccessFilter,
): Promise<CogitoSearchResult[]> {
  const allowed: CogitoSearchResult[] = [];
  for (const result of results) {
    const sessionId = stringField(result, "session_id") ?? stringField(result, "sessionId");
    if (sessionId === undefined) continue;
    const session = await filter.getSession(sessionId);
    if (!isRecord(session)) continue;
    const folderId = stringField(session, "folder_id") ?? stringField(session, "folderId");
    if (await filter.isFolderAllowed(folderId, session)) {
      allowed.push(result);
    }
  }
  return allowed;
}

async function collectSingleNodeBrief(
  node: CogitoNode,
  collector: CogitoBriefCollector,
  options: { timeoutSeconds: number; nowIso: () => string },
): Promise<CogitoBriefNodeEntry> {
  try {
    const result = await collector.reflectBrief(node, options.timeoutSeconds);
    if (!isRecord(result)) {
      return errorNodeEntry(
        node,
        "error",
        "invalid_reflect_brief_response",
        new TypeError(`reflect_brief response must be object, got ${typeName(result)}`),
        options.nowIso,
      );
    }
    const brief = result.brief;
    if (!isRecord(brief)) {
      return errorNodeEntry(
        node,
        "error",
        "invalid_reflect_brief_response",
        new TypeError("reflect_brief response missing object field 'brief'"),
        options.nowIso,
      );
    }
    return {
      node_id: node.id,
      status: "ok",
      checked_at: typeof result.checked_at === "string" ? result.checked_at : options.nowIso(),
      source: nodeSource(),
      data: brief,
      errors: [],
    };
  } catch (error) {
    if (error instanceof CogitoBriefTimeoutError) {
      return errorNodeEntry(node, "timeout", "node_timeout", error, options.nowIso);
    }
    if (error instanceof CogitoBriefUnavailableError) {
      return errorNodeEntry(node, "unavailable", "node_unavailable", error, options.nowIso);
    }
    return errorNodeEntry(node, "error", "node_error", error, options.nowIso);
  }
}

function parseSearchQuery(query: unknown): Validation<CogitoSearchParams> {
  const q = stringQuery(query, "q", { allowEmpty: false });
  if (q === undefined) return { ok: false, statusCode: 422, detail: "q is required" };
  const topK = integerQuery(query, "top_k", 10);
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    return { ok: false, statusCode: 422, detail: "top_k must be between 1 and 100" };
  }
  const searchSessionId = booleanQuery(query, "search_session_id", false);
  if (searchSessionId === undefined) {
    return {
      ok: false,
      statusCode: 422,
      detail: "search_session_id must be a boolean",
    };
  }
  const includeTurnSummaries = booleanQuery(
    query,
    "include_turn_summaries",
    false,
  );
  const includeHighlight = booleanQuery(query, "include_highlight", false);
  const includeStory = booleanQuery(query, "include_story", false);
  if (includeTurnSummaries === undefined) {
    return {
      ok: false,
      statusCode: 422,
      detail: "include_turn_summaries must be a boolean",
    };
  }
  if (includeHighlight === undefined) {
    return {
      ok: false,
      statusCode: 422,
      detail: "include_highlight must be a boolean",
    };
  }
  if (includeStory === undefined) {
    return {
      ok: false,
      statusCode: 422,
      detail: "include_story must be a boolean",
    };
  }
  const eventTypes = stringQuery(query, "event_types", { allowEmpty: true });
  const eventCategories = stringQuery(query, "event_categories", { allowEmpty: true });
  return {
    ok: true,
    value: {
      q,
      top_k: topK,
      search_session_id: searchSessionId,
      include_turn_summaries: includeTurnSummaries,
      include_highlight: includeHighlight,
      include_story: includeStory,
      ...(eventTypes !== undefined ? { event_types: eventTypes } : {}),
      ...(eventCategories !== undefined ? { event_categories: eventCategories } : {}),
    },
  };
}

function parseBriefTimeout(query: unknown): Validation<number> {
  const timeoutSeconds = numberQuery(query, "timeout", DEFAULT_BRIEF_TIMEOUT_SECONDS);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 30) {
    return {
      ok: false,
      statusCode: 422,
      detail: "timeout must be greater than 0 and less than or equal to 30",
    };
  }
  return { ok: true, value: timeoutSeconds };
}

async function resolveSearchAccess(
  options: CogitoRouteOptions,
  request: FastifyRequest,
): Promise<CogitoSearchAccess> {
  if (options.accessProvider === undefined) return { restricted: false };
  return options.accessProvider.resolveAccess(request);
}

async function filterRestrictedResults(
  options: CogitoRouteOptions,
  request: FastifyRequest,
  response: CogitoSearchResponse,
): Promise<CogitoSearchResponse> {
  if (options.accessProvider?.filterResults === undefined) {
    throw new Error("Restricted Cogito search requires an access result filter");
  }
  return options.accessProvider.filterResults({ request, response });
}

function errorNodeEntry(
  node: CogitoNode,
  status: Exclude<CogitoBriefStatus, "ok">,
  code: string,
  error: unknown,
  now: () => string,
): CogitoBriefNodeEntry {
  return {
    node_id: node.id,
    status,
    checked_at: now(),
    source: nodeSource(),
    data: null,
    errors: [
      {
        code,
        message: errorMessage(error),
      },
    ],
  };
}

function aggregateStatus(entries: CogitoBriefNodeEntry[]): CogitoBriefAggregate["status"] {
  if (entries.length === 0) return "empty";
  if (entries.every((entry) => entry.status === "ok")) return "ok";
  if (entries.some((entry) => entry.status === "ok")) return "partial";
  return "error";
}

function supportsReflectBrief(node: CogitoNode): boolean {
  return isRecord(node.capabilities) && node.capabilities.reflect_brief === true;
}

function aggregateSource() {
  return {
    type: "orchestrator",
    transport: "node_ws_command",
    command: "reflect_brief",
  } as const;
}

function nodeSource() {
  return {
    type: "node",
    transport: "websocket",
    command: "reflect_brief",
  } as const;
}

function stringQuery(
  query: unknown,
  key: string,
  options: { allowEmpty: boolean },
): string | undefined {
  const value = queryValue(query, key);
  if (typeof value !== "string") return undefined;
  if (!options.allowEmpty && value.length === 0) return undefined;
  return value;
}

function integerQuery(query: unknown, key: string, fallback: number): number {
  const value = queryValue(query, key);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function numberQuery(query: unknown, key: string, fallback: number): number {
  const value = queryValue(query, key);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  return Number(value);
}

function booleanQuery(query: unknown, key: string, fallback: boolean): boolean | undefined {
  const value = queryValue(query, key);
  if (value === undefined) return fallback;
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function queryValue(query: unknown, key: string): unknown {
  if (!isRecord(query) || !(key in query)) return undefined;
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function routeError(reply: FastifyReply, statusCode: number, detail: string): FastifyReply {
  return reply.code(statusCode).send({ detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function nowIso(): string {
  return new Date().toISOString();
}
