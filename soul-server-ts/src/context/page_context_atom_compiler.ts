import type { Logger } from "pino";

import {
  formatAtomContext,
  type AtomFetchConfig,
} from "./atom_context.js";
import {
  compileContextSources,
  createContextSource,
} from "./compiler/index.js";
import type {
  AtomRefPageContextCandidate,
  PageContextCandidate,
} from "./page_context_assembler.js";
import { selectNearestPageContextCandidates } from "./page_context_assembler.js";

const DISABLED_ATOM_CONFIG: AtomFetchConfig = {
  enabled: false,
  serverUrl: "",
  apiKey: "",
};

export async function compilePageAtomCandidates(
  candidates: PageContextCandidate[],
  atomConfig: AtomFetchConfig | undefined,
  logger: Pick<Logger, "warn">,
): Promise<PageContextCandidate[]> {
  const selected = selectNearestPageContextCandidates(candidates).filter(
    (candidate): candidate is AtomRefPageContextCandidate => candidate.category === "atom_ref",
  );
  const sources = selected.map((candidate) => createContextSource(
    {
      nodeId: candidate.nodeId,
      depth: candidate.depth,
      titlesOnly: candidate.titlesOnly,
      ...(candidate.limit !== undefined ? { limit: candidate.limit } : {}),
      ...(candidate.mode !== undefined ? { mode: candidate.mode } : {}),
    },
    {
      id: pageAtomSourceId(candidate),
      label: `page atom_ref: ${candidate.nodeId}`,
      instance: candidate.instance,
      priority: -candidate.distance,
      neverTruncate: false,
    },
  ));
  const compilation = await compileContextSources(
    atomConfig ?? DISABLED_ATOM_CONFIG,
    sources,
    logger,
  );
  const sectionById = new Map(compilation.sections.map((section) => [section.source.id, section]));
  const manifestById = new Map(compilation.manifest.sources.map((source) => [source.id, source]));

  return candidates.map((candidate) => {
    if (candidate.category !== "atom_ref") return candidate;
    const id = pageAtomSourceId(candidate);
    const section = sectionById.get(id);
    const sourceManifest = manifestById.get(id);
    if (!section || !sourceManifest) return candidate;
    return {
      ...candidate,
      priority: section.source.priority,
      neverTruncate: section.source.neverTruncate,
      sourceManifest,
      ...(section.markdown ? { compiledText: formatAtomContext(section.markdown) } : {}),
    };
  });
}

function pageAtomSourceId(candidate: AtomRefPageContextCandidate): string {
  return `page:${candidate.pageId}:${candidate.blockId}`;
}
