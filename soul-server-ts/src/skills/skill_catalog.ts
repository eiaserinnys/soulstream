import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";

import { fetchAtomMarkdown, type AtomFetchConfig } from "../context/atom_context.js";

export const DEFAULT_SKILL_CATALOG_NODE_ID = "9542295f-6f69-4e7f-95cd-7ce0fbe3512b";
const CACHE_TTL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillCatalogEntry {
  name: string;
  description: string;
  bodyNodeId: string;
  notes?: string;
}

type CatalogLogger = Pick<Logger, "warn">;

export interface LoadSkillCatalogInput {
  nodeId: string;
  atom: AtomFetchConfig;
  logger: CatalogLogger;
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

export async function loadSkillCatalog({ nodeId, atom, logger }: LoadSkillCatalogInput): Promise<SkillCatalogEntry[]> {
  const now = Date.now();
  const cached = cache.get(nodeId);
  if (cached && cached.expiresAt > now) return cached.entries;

  const markdown = await fetchAtomMarkdown(
    atom,
    { nodeId, depth: 1, titlesOnly: false, includeIds: true },
    logger,
  );
  if (markdown === null) throw new Error("Failed to fetch skill catalog");

  const entries = parseSkillCatalogMarkdown(markdown, logger);
  cache.set(nodeId, { expiresAt: now + CACHE_TTL_MS, entries });
  return entries;
}
