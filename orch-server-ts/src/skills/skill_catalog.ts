import type { FastifyBaseLogger } from "fastify";
import { parse as parseYaml } from "yaml";

import type { AtomHttpClient } from "../atom/atom_routes.js";
export { loadAtomNodeBody, loadAtomNodeMetadata } from "./skill_atom_reader.js";
export type { AtomNodeMetadata, LoadedAtomBody, LoadAtomNodeBodyInput } from "./skill_atom_reader.js";

export interface AtomFetchConfig { enabled: boolean; serverUrl: string; apiKey: string }

export const DEFAULT_SKILL_CATALOG_NODE_ID = "9542295f-6f69-4e7f-95cd-7ce0fbe3512b";
export const DEFAULT_DOMAIN_CATALOG_NODE_ID = "a715cf8f-dfa8-4300-b922-5ca231cac6ca";
export const DEFAULT_MIN_JEV_SCORE = 0.25;
const CACHE_TTL_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillCatalogEntry {
  name: string;
  description: string;
  bodyNodeId: string;
  nodeId?: string;
  notes?: string;
  activity?: { medium?: string; operations?: string[]; acceptsInput?: string[] };
  probeIntents?: string[];
}

export interface DomainCatalogBinding {
  targetCatalog: string;
  targetAxis: string;
  sheetTemplate: string;
  grid?: string;
}

export interface DomainCatalogShard {
  name: string;
  nodeId: string;
  sampleNodeId?: string;
  cues?: string[];
}

export interface DomainCatalogEntry {
  name: string;
  description: string;
  bodyNodeId: string;
  aliases?: string[];
  axis: string[];
  composition: "orthogonal" | "bundle";
  appliesTo?: { media?: string[]; operations?: string[] };
  providesInput?: string[];
  sampleCues?: string[];
  shards?: DomainCatalogShard[];
  bindings?: DomainCatalogBinding[];
}

type CatalogLogger = Pick<FastifyBaseLogger, "warn">;

export interface LoadSkillCatalogInput {
  nodeId: string;
  atom: AtomFetchConfig;
  logger: CatalogLogger;
  httpClient: AtomHttpClient;
}

const cache = new Map<string, { expiresAt: number; entries: SkillCatalogEntry[] }>();
const domainCatalogCache = new Map<string, { expiresAt: number; entries: DomainCatalogEntry[] }>();

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseSkillCatalogMarkdown(
  markdown: string,
  logger: CatalogLogger,
): SkillCatalogEntry[] {
  const lines = markdown.split("\n");
  const headings: Array<{ name: string; nodeId?: string; bodyStart: number }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const nodeId = /<!--\s*node:([0-9a-f-]{36})\b.*?-->/.exec(heading[1]!)?.[1];
    const name = heading[1]!
      .replace(/\s*<!--.*?-->\s*$/, "")
      .trim();
    headings.push({ name, ...(nodeId ? { nodeId } : {}), bodyStart: index + 1 });
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
      ...(heading.nodeId ? { nodeId: heading.nodeId } : {}),
    };
    if (typeof data.notes === "string") entry.notes = data.notes;
    const activityData = recordValue(data.activity);
    if (activityData) {
      const activity: NonNullable<SkillCatalogEntry["activity"]> = {};
      if (typeof activityData.medium === "string") activity.medium = activityData.medium;
      const operations = stringArray(activityData.operations);
      if (operations) activity.operations = operations;
      const acceptsInput = stringArray(activityData.accepts_input);
      if (acceptsInput) activity.acceptsInput = acceptsInput;
      if (Object.keys(activity).length > 0) entry.activity = activity;
    }
    const probeIntents = stringArray(data.probe_intents);
    if (probeIntents) entry.probeIntents = probeIntents;
    entries.push(entry);
  }
  return entries;
}

export function parseDomainCatalogMarkdown(
  markdown: string,
  logger: CatalogLogger,
): DomainCatalogEntry[] {
  const lines = markdown.split("\n");
  const headings: Array<{ name: string; nodeId: string | undefined; bodyStart: number }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,6}\s+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    const nodeId = /<!--\s*node:([0-9a-f-]{36})\b.*?-->/.exec(heading[1]!)?.[1];
    const name = heading[1]!
      .replace(/\s*<!--.*?-->\s*$/, "")
      .trim();
    headings.push({ name, nodeId, bodyStart: index + 1 });
  }

  const entries: DomainCatalogEntry[] = [];
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
      logger.warn({ name: heading.name }, "[skills] invalid domain catalog YAML; skipping");
      continue;
    }

    const data = recordValue(parsed) ?? {};
    const bodyNodeId = data.body_node_id;
    if (
      typeof heading.nodeId !== "string" || !UUID_PATTERN.test(heading.nodeId) ||
      typeof bodyNodeId !== "string" || !UUID_PATTERN.test(bodyNodeId)
    ) {
      logger.warn({ name: heading.name }, "[skills] domain catalog entry has invalid node IDs; skipping");
      continue;
    }

    const axis = stringArray(data.axis);
    const composition = data.composition;
    if (!axis || (composition !== "orthogonal" && composition !== "bundle")) {
      logger.warn({ name: heading.name }, "[skills] domain catalog entry has invalid routing metadata; skipping");
      continue;
    }

    const entry: DomainCatalogEntry = {
      name: heading.name,
      description: typeof data.description === "string" ? data.description : "",
      bodyNodeId,
      axis,
      composition,
    };
    const aliases = stringArray(data.aliases);
    if (aliases) entry.aliases = aliases;
    const providesInput = stringArray(data.provides_input);
    if (providesInput) entry.providesInput = providesInput;
    const sampleCues = stringArray(data.sample_cues);
    if (sampleCues) entry.sampleCues = sampleCues;

    const appliesToData = recordValue(data.applies_to);
    if (appliesToData) {
      const appliesTo: NonNullable<DomainCatalogEntry["appliesTo"]> = {};
      const media = stringArray(appliesToData.media);
      if (media) appliesTo.media = media;
      const operations = stringArray(appliesToData.operations);
      if (operations) appliesTo.operations = operations;
      if (Object.keys(appliesTo).length > 0) entry.appliesTo = appliesTo;
    }

    if (Array.isArray(data.shards)) {
      entry.shards = data.shards.flatMap((value): DomainCatalogShard[] => {
        const shard = recordValue(value);
        if (
          !shard || typeof shard.name !== "string" ||
          typeof shard.node_id !== "string" || !UUID_PATTERN.test(shard.node_id)
        ) return [];
        const parsedShard: DomainCatalogShard = { name: shard.name, nodeId: shard.node_id };
        if (typeof shard.sample_node_id === "string" && UUID_PATTERN.test(shard.sample_node_id)) {
          parsedShard.sampleNodeId = shard.sample_node_id;
        }
        const cues = stringArray(shard.cues);
        if (cues) parsedShard.cues = cues;
        return [parsedShard];
      });
    }

    if (Array.isArray(data.bindings)) {
      entry.bindings = data.bindings.flatMap((value): DomainCatalogBinding[] => {
        const binding = recordValue(value);
        if (
          !binding || typeof binding.target_catalog !== "string" ||
          typeof binding.target_axis !== "string" || typeof binding.sheet_template !== "string"
        ) return [];
        const parsedBinding: DomainCatalogBinding = {
          targetCatalog: binding.target_catalog,
          targetAxis: binding.target_axis,
          sheetTemplate: binding.sheet_template,
        };
        if (typeof binding.grid === "string") parsedBinding.grid = binding.grid;
        return [parsedBinding];
      });
    }

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

export async function loadDomainCatalog({ nodeId, atom, logger, httpClient }: LoadSkillCatalogInput): Promise<DomainCatalogEntry[]> {
  const now = Date.now();
  const cached = domainCatalogCache.get(nodeId);
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
    } catch (error) { logger.warn({ err: error, nodeId }, "[atom] domain catalog compile error"); }
  }
  if (markdown === null) throw new Error("Failed to fetch domain catalog");

  if (markdown.includes("<!-- truncated")) {
    logger.warn({ nodeId }, "[atom] domain catalog markdown was truncated");
  }

  const entries = parseDomainCatalogMarkdown(markdown, logger);
  domainCatalogCache.set(nodeId, { expiresAt: now + CACHE_TTL_MS, entries });
  return entries;
}

export function computeCatalogTagBoost(
  skill: SkillCatalogEntry | undefined,
  catalog: DomainCatalogEntry,
): { tagBoost: number; matchedDimensions: string[] } {
  let boost = 0;
  const matchedDimensions: string[] = [];
  if (skill?.activity?.medium && catalog.appliesTo?.media?.includes(skill.activity.medium)) {
    boost += 0.12;
    matchedDimensions.push("medium");
  }
  if (skill?.activity?.operations?.some((operation) => catalog.appliesTo?.operations?.includes(operation))) {
    boost += 0.08;
    matchedDimensions.push("operations");
  }
  if (skill?.activity?.acceptsInput?.some((input) => catalog.providesInput?.includes(input))) {
    boost += 0.05;
    matchedDimensions.push("input");
  }
  return { tagBoost: Number(boost.toFixed(4)), matchedDimensions };
}

export interface RankedDomainCatalogMatch {
  name: string;
  description: string;
  body_node_id: string;
  aliases?: string[];
  axis: string[];
  composition: "orthogonal" | "bundle";
  applies_to?: { media?: string[]; operations?: string[] };
  provides_input?: string[];
  sample_cues?: string[];
  shards?: Array<{ name: string; node_id: string; sample_node_id?: string; cues?: string[] }>;
  jev_score: number;
  tag_boost: number;
  matched_dimensions: string[];
  score: number;
}

export interface ActiveDomainCatalogBinding {
  source_catalog: string;
  target_catalog: string;
  target_axis: string;
  sheet_template: string;
  grid?: string;
}

export function catalogEvaluationText(catalog: DomainCatalogEntry): string {
  return [
    `${catalog.name}: ${catalog.description}`,
    catalog.aliases?.length ? `Aliases: ${catalog.aliases.join(", ")}` : undefined,
    `Axes: ${catalog.axis.join(", ")}`,
    `Composition: ${catalog.composition}`,
    catalog.appliesTo?.media?.length ? `Media: ${catalog.appliesTo.media.join(", ")}` : undefined,
    catalog.appliesTo?.operations?.length ? `Operations: ${catalog.appliesTo.operations.join(", ")}` : undefined,
    catalog.providesInput?.length ? `Inputs: ${catalog.providesInput.join(", ")}` : undefined,
    catalog.sampleCues?.length ? `Cues: ${catalog.sampleCues.join("; ")}` : undefined,
    catalog.shards?.length ? `Shards: ${catalog.shards.map((shard) => `${shard.name}: ${(shard.cues ?? []).join(", ")}`).join("; ")}` : undefined,
    catalog.bindings?.length ? `Bindings: ${catalog.bindings.map((binding) => `${binding.targetCatalog} (${binding.targetAxis})`).join("; ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function computeActiveBindings(catalogs: DomainCatalogEntry[]): ActiveDomainCatalogBinding[] {
  const selectedNames = new Set(catalogs.map(({ name }) => name));
  return catalogs.flatMap((catalog) =>
    (catalog.bindings ?? []).flatMap((binding): ActiveDomainCatalogBinding[] => {
      if (!selectedNames.has(binding.targetCatalog)) return [];
      return [{
        source_catalog: catalog.name,
        target_catalog: binding.targetCatalog,
        target_axis: binding.targetAxis,
        sheet_template: binding.sheetTemplate,
        ...(binding.grid ? { grid: binding.grid } : {}),
      }];
    }),
  );
}

export function rankAndComposeCatalogs({
  skill,
  catalogs,
  jevScores,
  limit,
  minJevScore = DEFAULT_MIN_JEV_SCORE,
}: {
  skill: SkillCatalogEntry | undefined;
  catalogs: DomainCatalogEntry[];
  jevScores: Array<{ key: string; score: number }>;
  limit: number;
  minJevScore?: number;
}): { matches: RankedDomainCatalogMatch[]; active_bindings: ActiveDomainCatalogBinding[] } {
  const jevScoreByKey = new Map(jevScores.map(({ key, score }) => [key, score]));
  const ranked = catalogs.map((catalog) => {
    const jevScore = jevScoreByKey.get(catalog.name) ?? 0;
    const { tagBoost, matchedDimensions } = computeCatalogTagBoost(skill, catalog);
    const finalScore = jevScore >= minJevScore ? Number((jevScore + tagBoost).toFixed(4)) : 0;
    return { catalog, jevScore, tagBoost, matchedDimensions, finalScore };
  }).filter(({ finalScore }) => finalScore > 0)
    .sort((left, right) => right.finalScore - left.finalScore);

  const selected: typeof ranked = [];
  const occupiedBundleAxes = new Set<string>();
  for (const candidate of ranked) {
    if (candidate.catalog.composition === "bundle" && candidate.catalog.axis.some((axis) => occupiedBundleAxes.has(axis))) {
      continue;
    }
    selected.push(candidate);
    if (candidate.catalog.composition === "bundle") {
      for (const axis of candidate.catalog.axis) occupiedBundleAxes.add(axis);
    }
    if (selected.length >= limit) break;
  }

  const selectedCatalogs = selected.map(({ catalog }) => catalog);
  const matches: RankedDomainCatalogMatch[] = selected.map(({ catalog, jevScore, tagBoost, matchedDimensions, finalScore }) => {
    const match: RankedDomainCatalogMatch = {
      name: catalog.name,
      description: catalog.description,
      body_node_id: catalog.bodyNodeId,
      axis: catalog.axis,
      composition: catalog.composition,
      jev_score: jevScore,
      tag_boost: tagBoost,
      matched_dimensions: matchedDimensions,
      score: finalScore,
    };
    if (catalog.aliases) match.aliases = catalog.aliases;
    if (catalog.appliesTo) match.applies_to = catalog.appliesTo;
    if (catalog.providesInput) match.provides_input = catalog.providesInput;
    if (catalog.sampleCues) match.sample_cues = catalog.sampleCues;
    if (catalog.shards) match.shards = catalog.shards.map((shard) => ({
      name: shard.name,
      node_id: shard.nodeId,
      ...(shard.sampleNodeId ? { sample_node_id: shard.sampleNodeId } : {}),
      ...(shard.cues ? { cues: shard.cues } : {}),
    }));
    return match;
  });

  const active_bindings = computeActiveBindings(selectedCatalogs);

  return { matches, active_bindings };
}
