import type { PageContextSourcesMarker } from "./project-context-inheritance";

export const ATOM_CONTEXT_SOURCES_KEY = "atom_context_sources";

interface SessionAtomNode {
  nodeId: string;
  title: string;
}

interface SessionContextItem {
  key: string;
  label: string;
  content: unknown;
}

export function buildSessionContextSelection({
  inheritCard,
  pageContextSources,
  documentPageIds,
  atomNode,
  guidance,
}: {
  inheritCard: boolean;
  pageContextSources: PageContextSourcesMarker;
  documentPageIds: readonly string[];
  atomNode: SessionAtomNode | null;
  guidance: string;
}): { needsPageAnchor: boolean; contextItems: SessionContextItem[] } {
  const pageIds = uniquePageIds([
    ...(inheritCard ? pageContextSources.content.pages.map((page) => page.page_id) : []),
    ...documentPageIds,
  ]);
  const contextItems: SessionContextItem[] = [];
  if (pageIds.length > 0) {
    contextItems.push({
      key: pageContextSources.key,
      label: inheritCard ? pageContextSources.label : "선택한 보드 문서",
      content: { pages: pageIds.map((pageId) => ({ page_id: pageId })) },
    });
  }
  if (atomNode?.nodeId.trim()) {
    contextItems.push({
      key: ATOM_CONTEXT_SOURCES_KEY,
      label: "선택한 atom 노드",
      content: {
        nodes: [{ node_id: atomNode.nodeId.trim(), depth: 3, titles_only: false }],
      },
    });
  }
  const trimmedGuidance = guidance.trim();
  if (trimmedGuidance) {
    contextItems.push({
      key: "session_guidance",
      label: "기본 지침",
      content: trimmedGuidance,
    });
  }
  return { needsPageAnchor: pageIds.length > 0, contextItems };
}

function uniquePageIds(pageIds: readonly string[]): string[] {
  const seen = new Set<string>();
  return pageIds.flatMap((pageId) => {
    const normalized = pageId.trim();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}
