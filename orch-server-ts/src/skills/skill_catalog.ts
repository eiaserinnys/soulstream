import type { FastifyBaseLogger } from "fastify";
import { parse as parseYaml } from "yaml";

import type { AtomHttpClient } from "../atom/atom_routes.js";

export interface AtomFetchConfig { enabled: boolean; serverUrl: string; apiKey: string }

export const DEFAULT_SKILL_CATALOG_NODE_ID = "9542295f-6f69-4e7f-95cd-7ce0fbe3512b";
const CACHE_TTL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillCatalogEntry {
  name: string;
  description: string;
  bodyNodeId: string;
  notes?: string;
}

type CatalogLogger = Pick<FastifyBaseLogger, "warn">;

export interface LoadSkillCatalogInput {
  nodeId: string;
  atom: AtomFetchConfig;
  logger: CatalogLogger;
  httpClient: AtomHttpClient;
}

const cache = new Map<string, { expiresAt: number; entries: SkillCatalogEntry[] }>();

export function parseSkillCatalogMarkdown(
  markdown: string,
  logger: CatalogLogger,
): SkillCatalogEntry[] {
  const lines = markdown.split("\n");
  const headings: Array<{ name: string; bodyStart: number }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const name = heading[1]!
      .replace(/\s*<!--.*?-->\s*$/, "")
      .trim();
    headings.push({ name, bodyStart: index + 1 });
  }

  const entries: SkillCatalogEntry[] = [];
  for (const [index, heading] of headings.entries()) {
    const nextHeading = headings[index + 1];
    const body = lines
      .slice(heading.bodyStart, nextHeading?.bodyStart === undefined ? undefined : nextHeading.bodyStart - 1)
      .join("\n")
      .trim();
    let parsed: unknown;
    try {
      parsed = parseYaml(body);
    } catch {
      logger.warn({ name: heading.name }, "[skills] invalid skill catalog YAML; skipping");
      continue;
    }

    const data = typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
    const bodyNodeId = data.body_node_id;
    if (typeof bodyNodeId !== "string" || !UUID_PATTERN.test(bodyNodeId)) {
      logger.warn({ name: heading.name }, "[skills] skill catalog entry has no valid body_node_id; skipping");
      continue;
    }

    const entry: SkillCatalogEntry = {
      name: heading.name,
      description: typeof data.description === "string" ? data.description : "",
      bodyNodeId,
    };
    if (typeof data.notes === "string") entry.notes = data.notes;
    entries.push(entry);
  }
  return entries;
}

export async function loadSkillCatalog({ nodeId, atom, logger, httpClient }: LoadSkillCatalogInput): Promise<SkillCatalogEntry[]> {
  const now = Date.now();
  const cached = cache.get(nodeId);
  if (cached && cached.expiresAt > now) return cached.entries;

  let markdown: string | null = null;
  if (atom.enabled && atom.serverUrl) {
    try {
      const url = new URL(`${atom.serverUrl.replace(/\/$/, "")}/api/tree/${nodeId}/compile`);
      url.searchParams.set("depth", "1");
      url.searchParams.set("max_chars", "50000");
      url.searchParams.set("include_ids", "true");
      const response = await httpClient.get({ url: url.toString(), headers: { "x-api-key": atom.apiKey } });
      const body = response.body as { markdown?: string } | null;
      if (response.statusCode === 200 && body?.markdown) markdown = body.markdown;
    } catch (error) { logger.warn({ err: error, nodeId }, "[atom] compile error"); }
  }
  if (markdown === null) throw new Error("Failed to fetch skill catalog");

  const entries = parseSkillCatalogMarkdown(markdown, logger);
  cache.set(nodeId, { expiresAt: now + CACHE_TTL_MS, entries });
  return entries;
}
