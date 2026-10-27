import type { FastifyBaseLogger } from "fastify";

import type { AtomHttpClient } from "../atom/atom_routes.js";
import type { AtomFetchConfig } from "./skill_catalog.js";
import { stripCompileHeader } from "./link_blocks.js";

type CatalogLogger = Pick<FastifyBaseLogger, "warn">;

export interface LoadedAtomBody {
  nodeId: string;
  markdown: string;
  version: number;
  childCount: number;
}

export interface AtomNodeMetadata {
  nodeId: string;
  version: number;
  parentNodeId: string | null;
}

export interface LoadAtomNodeBodyInput {
  nodeId: string;
  bodyNodeId: string;
  atom: AtomFetchConfig;
  logger: CatalogLogger;
  httpClient: AtomHttpClient;
}

const CACHE_TTL_MS = 60_000;
const bodyCache = new Map<string, { expiresAt: number; body: LoadedAtomBody }>();
const nodeMetadataCache = new Map<string, { expiresAt: number; metadata: AtomNodeMetadata }>();

function cacheKey(serverUrl: string, nodeId: string): string {
  return `${serverUrl.replace(/\/+$/u, "")}:${nodeId}`;
}

function atomHeaders(atom: AtomFetchConfig): Record<string, string> {
  return { "x-api-key": atom.apiKey };
}

function atomUrl(atom: AtomFetchConfig, path: string): string {
  return `${atom.serverUrl.replace(/\/+$/u, "")}${path}`;
}

export async function loadAtomNodeMetadata({
  bodyNodeId,
  atom,
  httpClient,
}: LoadAtomNodeBodyInput): Promise<AtomNodeMetadata> {
  if (!atom.enabled || !atom.serverUrl) throw new Error("Atom integration is not configured");
  const key = cacheKey(atom.serverUrl, bodyNodeId);
  const cached = nodeMetadataCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;

  if (!httpClient.post) throw new Error("Atom MCP metadata client is not configured");
  const response = await httpClient.post({
    url: atomUrl(atom, "/mcp"),
    headers: {
      ...atomHeaders(atom),
      accept: "application/json, text/event-stream",
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_node", arguments: { node_id: bodyNodeId } },
    },
  });
  const envelope = response.body as {
    result?: { content?: Array<{ text?: unknown }>; isError?: unknown };
    error?: unknown;
  } | null;
  const nodeText = envelope?.result?.content?.find((item) => typeof item.text === "string")?.text;
  let node: { id?: unknown; parent_node_id?: unknown; card?: { version?: unknown } } | undefined;
  try {
    node = typeof nodeText === "string" ? JSON.parse(nodeText) as typeof node : undefined;
  } catch {
    node = undefined;
  }
  const version = node?.card?.version;
  if (
    response.statusCode !== 200 || envelope?.error || envelope?.result?.isError === true ||
    typeof version !== "number" || !Number.isInteger(version)
  ) {
    throw new Error(`Failed to load Atom node metadata for ${bodyNodeId}`);
  }
  const metadata: AtomNodeMetadata = {
    nodeId: typeof node?.id === "string" ? node.id : bodyNodeId,
    version,
    parentNodeId: typeof node?.parent_node_id === "string" ? node.parent_node_id : null,
  };
  nodeMetadataCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, metadata });
  return metadata;
}

export async function loadAtomNodeBody(input: LoadAtomNodeBodyInput): Promise<LoadedAtomBody> {
  const { bodyNodeId, atom, httpClient } = input;
  if (!atom.enabled || !atom.serverUrl) throw new Error("Atom integration is not configured");
  const key = cacheKey(atom.serverUrl, bodyNodeId);
  const cached = bodyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.body;

  const [metadata, compiledMarkdown] = await Promise.all([
    loadAtomNodeMetadata(input),
    (async () => {
      const url = new URL(atomUrl(atom, `/api/tree/${encodeURIComponent(bodyNodeId)}/compile`));
      url.searchParams.set("depth", "0");
      url.searchParams.set("include_ids", "true");
      const response = await httpClient.get({ url: url.toString(), headers: atomHeaders(atom) });
      const result = response.body as { markdown?: unknown } | null;
      if (response.statusCode !== 200 || typeof result?.markdown !== "string") {
        throw new Error(`Failed to compile Atom node ${bodyNodeId}`);
      }
      return result.markdown;
    })(),
  ]);

  const outlineUrl = new URL(atomUrl(atom, "/api/tree/outline"));
  outlineUrl.searchParams.set("depth", "1");
  if (metadata.parentNodeId) outlineUrl.searchParams.set("node_id", metadata.parentNodeId);
  const outlineResponse = await httpClient.get({ url: outlineUrl.toString(), headers: atomHeaders(atom) });
  const outline = outlineResponse.body as { nodes?: Array<{ id?: unknown; child_count?: unknown }> } | null;
  const nodeInOutline = outline?.nodes?.find((node) => node.id === bodyNodeId);
  if (outlineResponse.statusCode !== 200 || typeof nodeInOutline?.child_count !== "number") {
    throw new Error(`Failed to read Atom node outline for ${bodyNodeId}`);
  }

  const body: LoadedAtomBody = {
    nodeId: metadata.nodeId,
    markdown: stripCompileHeader(compiledMarkdown),
    version: metadata.version,
    childCount: nodeInOutline.child_count,
  };
  bodyCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, body });
  return body;
}
