import { atomContextSpecKey, type AtomContextSpec } from "./atom_context.js";
import { isPageContextSourcesItem } from "./page_context_resolver.js";
import type { ContextItem } from "./prompt_assembler.js";

export const ATOM_CONTEXT_SOURCES_KEY = "atom_context_sources";

export function extractAtomContextSourceSpecs(
  items: ContextItem[] | undefined,
): AtomContextSpec[] {
  const marker = items?.find((item) => item.key === ATOM_CONTEXT_SOURCES_KEY);
  if (!marker || !isRecord(marker.content) || !Array.isArray(marker.content.nodes)) return [];
  const seen = new Set<string>();
  return marker.content.nodes.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const nodeId = typeof entry.node_id === "string" ? entry.node_id.trim() : "";
    if (!nodeId) return [];
    const spec: AtomContextSpec = {
      nodeId,
      depth: finiteInteger(entry.depth, 3),
      titlesOnly: entry.titles_only === true,
      ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
    };
    const key = atomContextSpecKey(spec);
    if (seen.has(key)) return [];
    seen.add(key);
    return [spec];
  });
}

export function withoutSessionContextSourceMarkers(
  items: ContextItem[] | undefined,
): ContextItem[] {
  return (items ?? []).filter((item) => (
    !isPageContextSourcesItem(item) && item.key !== ATOM_CONTEXT_SOURCES_KEY
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}
