/**
 * Context compiler pipeline.
 *
 * The caller resolves yaml/session/folder sources into AtomContextSpec. Explicit Phase B modes
 * render and annotate here, while mode-less legacy specs retain their Phase A bytes. Phase C
 * evaluates applies_when here; the remaining budget pass-through stays behind the same consumer API.
 */
import type { Logger } from "pino";
import { createHash } from "node:crypto";

import {
  ATOM_CONTEXT_HEADER,
  fetchAtomMarkdownResult,
  formatAtomContext,
  formatAtomMarkdown,
  type AtomContextSpec,
  type AtomFetchConfig,
  type AtomFetchStatus,
} from "../atom_context.js";
import {
  isContextRenderMode,
  renderExplicitAtomSource,
  type ContextRenderMode,
} from "./render_modes.js";

type ContextCompilerLogger = Pick<Logger, "warn">;

export type ContextFilterField = "source" | "node_id" | "container_kind" | "agent";

export type ContextFilterParameters = Partial<Record<ContextFilterField, string>>;

export type ContextSourceStatus = AtomFetchStatus | "filtered";

export interface ContextSource extends AtomContextSpec {
  id: string;
  label: string;
  instance: "atom" | "atom-nl";
  priority: number;
  neverTruncate: boolean;
}

export interface CompiledContextSection {
  source: ContextSource;
  markdown: string | null;
  status: ContextSourceStatus;
  truncated: boolean;
  anchorCount: number;
}

export const CONTEXT_COMPILER_VERSION = "phase-d.v1";

export interface ContextManifestUsage {
  limit: number;
  used: number;
  omitted: number;
}

export interface PageContextTruncation {
  categories: {
    guidance: ContextManifestUsage;
    atom_ref: ContextManifestUsage;
    session_defaults: ContextManifestUsage;
  };
  total: ContextManifestUsage;
}

export interface ContextManifestSource {
  id: string;
  label: string;
  instance: "atom" | "atom-nl";
  node_id: string;
  mode: ContextRenderMode;
  depth: number;
  titles_only: boolean;
  include_ids: boolean;
  limit?: number;
  priority: number;
  never_truncate: boolean;
  applies_when?: Record<string, unknown>;
  chars: number;
  token_estimate: number;
  status: ContextSourceStatus;
  truncated: boolean;
  anchor_count: number;
}

export interface ContextManifest {
  compiler_version: typeof CONTEXT_COMPILER_VERSION;
  spec_hash: string;
  source_count: number;
  total_chars: number;
  total_token_estimate: number;
  sources: ContextManifestSource[];
  page_context?: { truncation: PageContextTruncation };
}

export interface ContextCompilationResult {
  sections: CompiledContextSection[];
  assembled: string | null;
  manifest: ContextManifest;
}

export function createContextSource(
  spec: AtomContextSpec,
  overrides: Partial<Pick<
    ContextSource,
    "id" | "label" | "instance" | "priority" | "neverTruncate"
  >> = {},
): ContextSource {
  return {
    ...spec,
    id: overrides.id ?? spec.nodeId,
    label: overrides.label ?? `atom node: ${spec.nodeId}`,
    instance: overrides.instance ?? "atom",
    priority: overrides.priority ?? 0,
    neverTruncate: overrides.neverTruncate ?? false,
  };
}

function resolveContextSources(specs: readonly AtomContextSpec[]): ContextSource[] {
  return specs.map((spec) => createContextSource(spec));
}

const CONTEXT_FILTER_FIELDS = new Set<ContextFilterField>([
  "source",
  "node_id",
  "container_kind",
  "agent",
]);

const KNOWN_CALLER_SOURCES = new Set([
  "agent",
  "api",
  "browser",
  "channel_observer",
  "execute-proxy",
  "llm",
  "slack",
  "soul-app",
  "system",
  "trello_watcher",
]);

const KNOWN_CONTAINER_KINDS = new Set(["folder", "task", "runbook"]);
const IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

interface FilteredContextSources {
  included: ContextSource[];
  filtered: Set<ContextSource>;
}

function filterContextSources(
  specs: readonly ContextSource[],
  parameters: ContextFilterParameters,
  logger: ContextCompilerLogger,
): FilteredContextSources {
  const included: ContextSource[] = [];
  const filtered = new Set<ContextSource>();
  for (const source of specs) {
    if (sourceMatches(source, parameters, logger)) included.push(source);
    else filtered.add(source);
  }
  return { included, filtered };
}

function sourceMatches(
  source: ContextSource,
  parameters: ContextFilterParameters,
  logger: ContextCompilerLogger,
): boolean {
  const conditions = source.appliesWhen;
  if (conditions === undefined) return true;
  for (const [rawField, rawValues] of Object.entries(conditions)) {
    if (!CONTEXT_FILTER_FIELDS.has(rawField as ContextFilterField)) {
      logger.warn(
        { field: rawField, nodeId: source.nodeId },
        "[context compiler] unknown applies_when field — ignoring condition",
      );
      continue;
    }
    const field = rawField as ContextFilterField;
    const values = recognizedConditionValues(field, rawValues, source, logger);
    if (values === undefined) continue;
    const actual = parameters[field];
    if (actual === undefined || !values.some((value) => conditionValueMatches(field, value, actual))) {
      return false;
    }
  }
  return true;
}

function recognizedConditionValues(
  field: ContextFilterField,
  rawValues: unknown,
  source: ContextSource,
  logger: ContextCompilerLogger,
): string[] | undefined {
  if (!Array.isArray(rawValues)) {
    warnUnknownConditionValue(field, rawValues, source, logger);
    return undefined;
  }
  if (rawValues.length === 0) return [];
  const values: string[] = [];
  let hasUnknownValue = false;
  for (const value of rawValues) {
    if (!isKnownConditionValue(field, value)) {
      warnUnknownConditionValue(field, value, source, logger);
      hasUnknownValue = true;
      continue;
    }
    values.push(value);
  }
  return hasUnknownValue || values.length === 0 ? undefined : values;
}

function isKnownConditionValue(field: ContextFilterField, value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (field === "source") return KNOWN_CALLER_SOURCES.has(value);
  if (field === "container_kind") return KNOWN_CONTAINER_KINDS.has(value);
  return IDENTIFIER_VALUE.test(value);
}

function warnUnknownConditionValue(
  field: ContextFilterField,
  value: unknown,
  source: ContextSource,
  logger: ContextCompilerLogger,
): void {
  logger.warn(
    { field, value, nodeId: source.nodeId },
    "[context compiler] unknown applies_when value — ignoring condition",
  );
}

function conditionValueMatches(
  field: ContextFilterField,
  desired: string,
  actual: string,
): boolean {
  if (field !== "container_kind") return desired === actual;
  return canonicalContainerKind(desired) === canonicalContainerKind(actual);
}

function canonicalContainerKind(value: string): string {
  return value === "runbook" ? "task" : value;
}

async function renderContextSources(
  config: AtomFetchConfig,
  sources: readonly ContextSource[],
  logger: ContextCompilerLogger,
): Promise<CompiledContextSection[]> {
  const sections: CompiledContextSection[] = [];
  for (const source of sources) {
    const requestedMode = source.mode;
    if (requestedMode !== undefined && !isContextRenderMode(requestedMode)) {
      logger.warn(
        { mode: requestedMode, nodeId: source.nodeId },
        "[context compiler] unknown atom render mode — using legacy rendering",
      );
    }
    if (isContextRenderMode(requestedMode)) {
      const rendered = await renderExplicitAtomSource(
        config,
        source,
        requestedMode,
        logger,
      );
      sections.push({
        source,
        markdown: rendered.markdown,
        status: rendered.status,
        truncated: rendered.truncated,
        anchorCount: rendered.anchorCount,
      });
      continue;
    }
    const result = await fetchAtomMarkdownResult(config, source, logger);
    sections.push({
      source,
      markdown: result.markdown,
      status: result.status,
      truncated: false,
      anchorCount: 0,
    });
  }
  return sections;
}

/** Phase B renderers annotate their own cut surfaces before this shared hook. */
function annotateContextSections(
  sections: readonly CompiledContextSection[],
): CompiledContextSection[] {
  return [...sections];
}

function assembleContextSections(sections: readonly CompiledContextSection[]): string | null {
  const renderedSections = sections.filter(({ status }) => status !== "filtered");
  if (renderedSections.length === 0) return null;
  if (renderedSections.length === 1) {
    const markdown = renderedSections[0]?.markdown;
    return markdown === null || markdown === undefined
      ? null
      : formatAtomContext(markdown);
  }

  const assembled = renderedSections.flatMap(({ source, markdown }) => {
    if (!markdown) return [];
    if (isContextRenderMode(source.mode)) return [formatAtomMarkdown(markdown)];
    return [[
      `## atom node: ${source.nodeId}`,
      `depth=${source.depth}, titles_only=${source.titlesOnly}`,
      "",
      formatAtomMarkdown(markdown),
    ].join("\n")];
  });
  if (assembled.length === 0) return null;
  return `${ATOM_CONTEXT_HEADER}\n${assembled.join("\n\n")}`;
}

function estimateTokenCount(chars: number): number {
  // Approximation only: Korean text and UUID-heavy content have different token ratios.
  return Math.ceil(chars / 4);
}

function desiredSpec(source: ContextSource | ContextManifestSource): Record<string, unknown> {
  if ("nodeId" in source) {
    return {
      id: source.id,
      label: source.label,
      instance: source.instance,
      node_id: source.nodeId,
      mode: effectiveMode(source),
      depth: source.depth,
      titles_only: source.titlesOnly,
      include_ids: source.includeIds ?? true,
      ...(source.limit !== undefined ? { limit: source.limit } : {}),
      priority: source.priority,
      never_truncate: source.neverTruncate,
      ...(source.appliesWhen !== undefined ? { applies_when: source.appliesWhen } : {}),
    };
  }
  return {
    id: source.id,
    label: source.label,
    instance: source.instance,
    node_id: source.node_id,
    mode: source.mode,
    depth: source.depth,
    titles_only: source.titles_only,
    include_ids: source.include_ids,
    ...(source.limit !== undefined ? { limit: source.limit } : {}),
    priority: source.priority,
    never_truncate: source.never_truncate,
    ...(source.applies_when !== undefined ? { applies_when: source.applies_when } : {}),
  };
}

function hashDesiredSpec(sources: readonly (ContextSource | ContextManifestSource)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(sources.map(desiredSpec)))
    .digest("hex");
}

function buildContextManifest(
  sections: readonly CompiledContextSection[],
  assembled: string | null,
): ContextManifest {
  const sources = sections.map(({
    source,
    markdown,
    status,
    truncated,
    anchorCount,
  }): ContextManifestSource => {
    const chars = markdown === null ? 0 : formatAtomMarkdown(markdown).length;
    return {
      ...desiredSpec(source),
      chars,
      token_estimate: estimateTokenCount(chars),
      status,
      truncated,
      anchor_count: anchorCount,
    } as ContextManifestSource;
  });
  const totalChars = assembled?.length ?? 0;
  return {
    compiler_version: CONTEXT_COMPILER_VERSION,
    spec_hash: hashDesiredSpec(sections.map(({ source }) => source)),
    source_count: sources.length,
    total_chars: totalChars,
    total_token_estimate: estimateTokenCount(totalChars),
    sources,
  };
}

export function contextManifestFromSources(
  sources: readonly ContextManifestSource[],
): ContextManifest {
  const copied = sources.map((source) => ({ ...source }));
  const totalChars = copied.reduce((sum, source) => sum + source.chars, 0);
  return {
    compiler_version: CONTEXT_COMPILER_VERSION,
    spec_hash: hashDesiredSpec(copied),
    source_count: copied.length,
    total_chars: totalChars,
    total_token_estimate: estimateTokenCount(totalChars),
    sources: copied,
  };
}

function effectiveMode(spec: AtomContextSpec): ContextRenderMode {
  return isContextRenderMode(spec.mode)
    ? spec.mode
    : spec.titlesOnly ? "titles" : "full";
}

export function mergeContextManifests(
  manifests: readonly ContextManifest[],
  pageTruncation?: PageContextTruncation,
): ContextManifest {
  const sources = manifests.flatMap((manifest) => manifest.sources);
  const totalChars = manifests.reduce((sum, manifest) => sum + manifest.total_chars, 0);
  return {
    compiler_version: CONTEXT_COMPILER_VERSION,
    spec_hash: hashDesiredSpec(sources),
    source_count: sources.length,
    total_chars: totalChars,
    total_token_estimate: estimateTokenCount(totalChars),
    sources,
    ...(pageTruncation ? { page_context: { truncation: pageTruncation } } : {}),
  };
}

export function extractPageContextTruncation(
  pageContextItem: { key: string; content: unknown } | null,
): PageContextTruncation | undefined {
  if (!pageContextItem || pageContextItem.key !== "page_context") return undefined;
  const content = pageContextItem.content;
  if (!isRecord(content) || !isRecord(content.metadata)) return undefined;
  const truncation = content.metadata.truncation;
  if (!isRecord(truncation) || !isRecord(truncation.categories)) return undefined;
  const guidance = toManifestUsage(truncation.categories.guidance);
  const atomRef = toManifestUsage(truncation.categories.atom_ref);
  const sessionDefaults = toManifestUsage(truncation.categories.session_defaults);
  const total = toManifestUsage(truncation.total);
  if (!guidance || !atomRef || !sessionDefaults || !total) return undefined;
  return {
    categories: {
      guidance,
      atom_ref: atomRef,
      session_defaults: sessionDefaults,
    },
    total,
  };
}

function toManifestUsage(value: unknown): ContextManifestUsage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.limit !== "number" ||
    typeof value.used !== "number" ||
    typeof value.omitted !== "number"
  ) {
    return undefined;
  }
  return { limit: value.limit, used: value.used, omitted: value.omitted };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function compileContextSources(
  config: AtomFetchConfig,
  sources: readonly ContextSource[],
  logger: ContextCompilerLogger,
  parameters: ContextFilterParameters = {},
): Promise<ContextCompilationResult> {
  const decisions = filterContextSources(sources, parameters, logger);
  const rendered = await renderContextSources(config, decisions.included, logger);
  const renderedBySource = new Map(rendered.map((section) => [section.source, section]));
  const observed = sources.map((source): CompiledContextSection => (
    decisions.filtered.has(source)
      ? {
          source,
          markdown: null,
          status: "filtered",
          truncated: false,
          anchorCount: 0,
        }
      : renderedBySource.get(source)!
  ));
  const annotated = annotateContextSections(observed);
  const assembled = assembleContextSections(annotated);
  return {
    sections: annotated,
    assembled,
    manifest: buildContextManifest(annotated, assembled),
  };
}

export async function compileContexts(
  config: AtomFetchConfig,
  specs: readonly AtomContextSpec[],
  logger: ContextCompilerLogger,
  parameters: ContextFilterParameters = {},
): Promise<ContextCompilationResult> {
  return await compileContextSources(config, resolveContextSources(specs), logger, parameters);
}
