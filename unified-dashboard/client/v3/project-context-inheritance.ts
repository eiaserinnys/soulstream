import type { CatalogFolder } from "@seosoyoung/soul-ui";

import type {
  ProjectAtomReference,
  ProjectGuidance,
  ProjectPageDetails,
  ProjectSessionDefault,
} from "./project-page-details";

export const PAGE_CONTEXT_SOURCES_KEY = "page_context_sources";

export interface ProjectContextSource {
  folderId: string;
  folderName: string;
  pageId: string;
}

export interface ProjectContextPage {
  source: ProjectContextSource;
  details: ProjectPageDetails;
}

export type SourcedProjectGuidance = ProjectGuidance & { source: ProjectContextSource };
export type SourcedProjectAtomReference = ProjectAtomReference & { source: ProjectContextSource };
export type SourcedProjectSessionDefault = ProjectSessionDefault & { source: ProjectContextSource };

export interface ProjectContextInheritance {
  pages: ProjectContextPage[];
  guidance: SourcedProjectGuidance[];
  atomReferences: SourcedProjectAtomReference[];
  sessionDefaults: SourcedProjectSessionDefault[];
}

export type ProjectContextSourceResolution =
  | { status: "resolved"; sources: ProjectContextSource[] }
  | { status: "unavailable" };

export type ProjectContextPreviewState =
  | { status: "loading"; folderId: string; data: null; message: null }
  | { status: "ready"; folderId: string; data: ProjectContextInheritance; message: null }
  | { status: "error"; folderId: string; data: null; message: string };

export interface PageContextSourcesMarker {
  key: typeof PAGE_CONTEXT_SOURCES_KEY;
  label: string;
  content: { pages: Array<{ page_id: string }> };
}

interface Ranked<T> {
  value: T;
  sourceIndex: number;
  blockIndex: number;
}

export function folderProjectContextSources(
  folderId: string,
  folders: readonly CatalogFolder[],
): ProjectContextSourceResolution {
  if (!folderId) return { status: "resolved", sources: [] };
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let current = byId.get(folderId);
  if (!current) return { status: "unavailable" };

  const path: CatalogFolder[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }

  return {
    status: "resolved",
    sources: path.reverse().flatMap((folder) => {
      const pageId = folder.projectPageId?.trim();
      return pageId ? [{ folderId: folder.id, folderName: folder.name, pageId }] : [];
    }),
  };
}

export function mergeProjectContextPages(
  pages: readonly ProjectContextPage[],
): ProjectContextInheritance {
  const guidance = new Map<string, Ranked<SourcedProjectGuidance>>();
  const atoms = new Map<string, Ranked<SourcedProjectAtomReference>>();
  const defaults = new Map<string, Ranked<SourcedProjectSessionDefault>>();

  pages.forEach(({ source, details }, sourceIndex) => {
    details.guidance.forEach((item, blockIndex) => {
      selectNearest(
        guidance,
        `guidance:${item.scope}`,
        ranked({ ...item, source }, sourceIndex, blockIndex),
      );
    });
    details.atomReferences.forEach((item, blockIndex) => {
      selectNearest(
        atoms,
        `atom_ref:${item.instance}:${item.nodeId}`,
        ranked({ ...item, source }, sourceIndex, blockIndex),
      );
    });
    details.sessionDefaults.forEach((item, blockIndex) => {
      selectNearest(
        defaults,
        `session_defaults:${item.scope}`,
        ranked({ ...item, source }, sourceIndex, blockIndex),
      );
    });
  });

  return {
    pages: pages.map((page) => ({ source: page.source, details: page.details })),
    guidance: selectedValues(guidance),
    atomReferences: selectedValues(atoms),
    sessionDefaults: selectedValues(defaults),
  };
}

export function beginProjectContextLoad(
  current: ProjectContextPreviewState,
  folderId: string,
  resolution: ProjectContextSourceResolution,
): ProjectContextPreviewState {
  if (current.folderId === folderId && current.status === "ready") return current;
  if (resolution.status === "unavailable" && current.folderId === folderId) return current;
  return { status: "loading", folderId, data: null, message: null };
}

export function completeProjectContextLoad(
  current: ProjectContextPreviewState,
  next: Extract<ProjectContextPreviewState, { status: "ready" }>,
): ProjectContextPreviewState {
  if (
    current.status === "ready"
    && current.folderId === next.folderId
    && JSON.stringify(current.data) === JSON.stringify(next.data)
  ) return current;
  return next;
}

export function buildPageContextSourcesMarker(
  inheritance: ProjectContextInheritance,
  taskPageId: string,
): PageContextSourcesMarker {
  return {
    key: PAGE_CONTEXT_SOURCES_KEY,
    label: "Project and task page context sources",
    content: {
      pages: [
        ...inheritance.pages.map((page) => ({ page_id: page.source.pageId })),
        { page_id: taskPageId },
      ],
    },
  };
}

function ranked<T>(value: T, sourceIndex: number, blockIndex: number): Ranked<T> {
  return { value, sourceIndex, blockIndex };
}

function selectedValues<T>(items: Map<string, Ranked<T>>): T[] {
  return [...items.values()]
    .sort((left, right) => left.sourceIndex - right.sourceIndex || left.blockIndex - right.blockIndex)
    .map((item) => item.value);
}

function selectNearest<T>(items: Map<string, Ranked<T>>, key: string, candidate: Ranked<T>): void {
  const current = items.get(key);
  if (!current || candidate.sourceIndex > current.sourceIndex) items.set(key, candidate);
}
