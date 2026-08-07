/**
 * Phase A context compiler.
 *
 * The caller already resolves legacy yaml/page/folder sources into AtomContextSpec. This module
 * establishes the seven-stage compiler boundary while preserving the legacy render and assembly
 * byte-for-byte. Phase B-D replace the pass-through stages without changing the consumer API.
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

type ContextCompilerLogger = Pick<Logger, "warn">;

export interface ContextSource {
  id: string;
  label: string;
  instance: "atom";
  legacy: AtomContextSpec;
}

export interface CompiledContextSection {
  source: ContextSource;
  markdown: string | null;
  status: AtomFetchStatus;
}

export const CONTEXT_COMPILER_VERSION = "phase-a.v1";

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
  instance: "atom";
  node_id: string;
  mode: "full" | "titles";
  depth: number;
  titles_only: boolean;
  include_ids: boolean;
  limit?: number;
  chars: number;
  token_estimate: number;
  status: AtomFetchStatus;
  truncated: false;
  anchor_count: 0;
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

function resolveContextSources(specs: readonly AtomContextSpec[]): ContextSource[] {
  return specs.map((legacy) => ({
    id: legacy.nodeId,
    label: `atom node: ${legacy.nodeId}`,
    instance: "atom",
    legacy: { ...legacy },
  }));
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
    const result = await fetchAtomMarkdownResult(config, source.legacy, logger);
    sections.push({
      source,
      markdown: result.markdown,
      status: result.status,
    });
  }
  return sections;
}

/** Phase B hook: no cut-surface annotations in Phase A. */
function annotateContextSections(
  sections: readonly CompiledContextSection[],
): CompiledContextSection[] {
  return [...sections];
}

/** Phase D hook: no compiler-owned budget in Phase A. */
function budgetContextSections(
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

  const assembled = sections.flatMap(({ source: { legacy }, markdown }) => {
    if (!markdown) return [];
    return [[
      `## atom node: ${legacy.nodeId}`,
      `depth=${legacy.depth}, titles_only=${legacy.titlesOnly}`,
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
  if ("legacy" in source) {
    const spec = source.legacy;
    return {
      id: source.id,
      label: source.label,
      instance: source.instance,
      node_id: spec.nodeId,
      mode: spec.titlesOnly ? "titles" : "full",
      depth: spec.depth,
      titles_only: spec.titlesOnly,
      include_ids: spec.includeIds ?? true,
      ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
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
  const sources = sections.map(({ source, markdown, status }): ContextManifestSource => {
    const chars = markdown === null ? 0 : formatAtomMarkdown(markdown).length;
    return {
      ...desiredSpec(source),
      chars,
      token_estimate: estimateTokenCount(chars),
      status,
      truncated: false,
      anchor_count: 0,
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

export async function compileContexts(
  config: AtomFetchConfig,
  specs: readonly AtomContextSpec[],
  logger: ContextCompilerLogger,
): Promise<ContextCompilationResult> {
  const resolved = resolveContextSources(specs);
  const filtered = filterContextSources(resolved);
  const rendered = await renderContextSources(config, filtered, logger);
  const annotated = annotateContextSections(rendered);
  const budgeted = budgetContextSections(annotated);
  const assembled = assembleContextSections(budgeted);
  return {
    sections: budgeted,
    assembled,
    manifest: buildContextManifest(budgeted, assembled),
  };
}
