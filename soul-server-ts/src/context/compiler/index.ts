/**
 * Phase A context compiler.
 *
 * The caller already resolves legacy yaml/page/folder sources into AtomContextSpec. This module
 * establishes the seven-stage compiler boundary while preserving the legacy render and assembly
 * byte-for-byte. Phase B-D replace the pass-through stages without changing the consumer API.
 */
import type { Logger } from "pino";

import {
  ATOM_CONTEXT_HEADER,
  fetchAtomMarkdown,
  formatAtomContext,
  formatAtomMarkdown,
  type AtomContextSpec,
  type AtomFetchConfig,
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
}

export interface ContextCompilationResult {
  sections: CompiledContextSection[];
  assembled: string | null;
  manifest: null;
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
    sections.push({
      source,
      markdown: await fetchAtomMarkdown(config, source.legacy, logger),
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
  return {
    sections: budgeted,
    assembled: assembleContextSections(budgeted),
    manifest: null,
  };
}
