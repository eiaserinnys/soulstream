/**
 * Context compiler pipeline.
 *
 * The caller resolves yaml/session/folder sources into AtomContextSpec. Explicit Phase B modes
 * render and annotate here, while mode-less legacy specs retain their Phase A bytes. Later phases
 * replace the remaining filter and budget pass-through stages without changing the consumer API.
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
  status: AtomFetchStatus;
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
  chars: number;
  token_estimate: number;
  status: AtomFetchStatus;
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

/** Phase C hook: legacy sources all apply in Phase A. */
function filterContextSources(specs: readonly ContextSource[]): ContextSource[] {
  return [...specs];
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
  if (sections.length === 0) return null;
  if (sections.length === 1) {
    const markdown = sections[0]?.markdown;
    return markdown === null || markdown === undefined
      ? null
      : formatAtomContext(markdown);
  }

  const assembled = sections.flatMap(({ source, markdown }) => {
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
): Promise<ContextCompilationResult> {
  const filtered = filterContextSources(sources);
  const rendered = await renderContextSources(config, filtered, logger);
  const annotated = annotateContextSections(rendered);
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
): Promise<ContextCompilationResult> {
  return await compileContextSources(config, resolveContextSources(specs), logger);
}
