import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";

import type { ContextItem } from "./prompt_assembler.js";
import type { PageContextAnchor } from "./page_context_repository.js";
import { formatAtomContext } from "./atom_context.js";
import { allocateContextBudget } from "./compiler/budget.js";
import {
  contextManifestFromSources,
  type ContextManifest,
  type ContextManifestSource,
} from "./compiler/index.js";
import { renderRootDrilldownAnchor } from "./compiler/render_modes.js";

interface CandidateBase {
  semanticKey: string;
  pageId: string;
  blockId: string;
  positionKey: string;
  distance: number;
}

export interface GuidancePageContextCandidate extends CandidateBase {
  category: "guidance";
  text: string;
  scope: string;
}

export interface AtomRefPageContextCandidate extends CandidateBase {
  category: "atom_ref";
  instance: "atom" | "atom-nl";
  nodeId: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number;
  mode?: string;
  priority?: number;
  neverTruncate?: boolean;
  compiledText?: string;
  sourceManifest?: ContextManifestSource;
}

export interface SessionDefaultsPageContextCandidate extends CandidateBase {
  category: "session_defaults";
  scope: string;
  agentId?: string;
  nodeId?: string;
}

export type PageContextCandidate =
  | GuidancePageContextCandidate
  | AtomRefPageContextCandidate
  | SessionDefaultsPageContextCandidate;

export interface PageContextTraversalFailure {
  stage: "page" | "mounts" | "block";
  pageId: string;
  blockId?: string;
  message: string;
}

export interface PageContextTraversal {
  candidates: PageContextCandidate[];
  visitedPages: number;
  failures: PageContextTraversalFailure[];
  truncated: boolean;
}

export interface PageContextBudgets {
  guidanceChars: number;
  atomRefChars: number;
  sessionDefaultsChars: number;
  totalChars: number;
}

export interface PageContextAssembler {
  assemble(anchor: PageContextAnchor | null, traversal: PageContextTraversal): ContextItem;
  assembleDetailed(
    anchor: PageContextAnchor | null,
    traversal: PageContextTraversal,
  ): PageContextAssembly;
}

export interface PageContextAssembly {
  contextItem: ContextItem;
  contextManifest: ContextManifest;
}

export const DEFAULT_PAGE_CONTEXT_BUDGETS: PageContextBudgets = {
  guidanceChars: 8_000,
  atomRefChars: 52_000,
  sessionDefaultsChars: 0,
  totalChars: 60_000,
};

export class DefaultPageContextAssembler implements PageContextAssembler {
  private readonly budgets: PageContextBudgets;

  constructor(budgets: Partial<PageContextBudgets> = {}) {
    this.budgets = { ...DEFAULT_PAGE_CONTEXT_BUDGETS, ...budgets };
  }

  assemble(anchor: PageContextAnchor | null, traversal: PageContextTraversal): ContextItem {
    return this.assembleDetailed(anchor, traversal).contextItem;
  }

  assembleDetailed(
    anchor: PageContextAnchor | null,
    traversal: PageContextTraversal,
  ): PageContextAssembly {
    const selected = selectNearestPageContextCandidates(traversal.candidates);
    const budget = allocateContextBudget({
      limits: {
        categories: {
          guidance: this.budgets.guidanceChars,
          atom_ref: this.budgets.atomRefChars,
          session_defaults: this.budgets.sessionDefaultsChars,
        },
        total: this.budgets.totalChars,
      },
      entries: selected.map((candidate) => ({
        id: candidateBudgetId(candidate),
        category: candidate.category,
        content: candidate.category === "guidance"
          ? candidate.text
          : candidate.category === "atom_ref"
            ? candidate.compiledText ?? null
            : null,
        ...(candidate.category === "atom_ref" && candidate.compiledText
          ? {
              fallback: formatAtomContext(
                renderRootDrilldownAnchor(candidate.nodeId, candidate.nodeId),
              ),
              fallbackAnchorCount: 1,
            }
          : {}),
        baseAnchorCount: candidate.category === "atom_ref"
          ? candidate.sourceManifest?.anchor_count ?? 0
          : 0,
        priority: candidate.category === "atom_ref"
          ? candidate.priority ?? -candidate.distance
          : -candidate.distance,
        neverTruncate: candidate.category === "atom_ref"
          ? candidate.neverTruncate ?? false
          : false,
        countTowardTotal: candidate.category !== "session_defaults",
      })),
    });
    const budgetedById = new Map(budget.entries.map((entry) => [entry.id, entry]));
    const rendered: Array<Record<string, unknown> & { candidate: PageContextCandidate }> = [];
    for (const candidate of selected) {
      const observed = budgetedById.get(candidateBudgetId(candidate));
      if (!observed?.content) continue;
      const truncated = observed.truncated
        || (candidate.category === "atom_ref" && candidate.sourceManifest?.truncated === true);
      if (candidate.category === "session_defaults") continue;
      rendered.push({
        candidate,
        category: candidate.category,
        semantic_key: candidate.semanticKey,
        page_id: candidate.pageId,
        block_id: candidate.blockId,
        ...(candidate.category === "guidance" ? {
          scope: candidate.scope,
          text: observed.content,
          ...(truncated ? { truncated: true } : {}),
        } : {
          instance: candidate.instance,
          node_id: candidate.nodeId,
          depth: candidate.depth,
          titles_only: candidate.titlesOnly,
          ...(candidate.mode !== undefined ? { mode: candidate.mode } : {}),
          ...(candidate.limit !== undefined ? { limit: candidate.limit } : {}),
          markdown: observed.content,
          ...(truncated ? { truncated: true } : {}),
          ...(observed.anchorCount > 0 ? { anchor_count: observed.anchorCount } : {}),
        }),
      });
    }
    const items = rendered
      .sort((a, b) => compareRootToLeaf(a.candidate, b.candidate))
      .map(({ candidate: _candidate, ...entry }) => entry);
    const contextItem: ContextItem = {
      key: "page_context",
      label: "Page ancestor context",
      content: {
        anchor: anchor ? { page_id: anchor.pageId, block_id: anchor.blockId } : null,
        items,
        metadata: {
          deduplicated: traversal.candidates.length - selected.length,
          traversal: {
            visited_pages: traversal.visitedPages,
            failures: traversal.failures.map((failure) => ({
              stage: failure.stage,
              page_id: failure.pageId,
              ...(failure.blockId ? { block_id: failure.blockId } : {}),
              message: failure.message,
            })),
            truncated: traversal.truncated,
          },
          truncation: {
            categories: budget.usage.categories,
            total: budget.usage.total,
          },
        },
      },
    };
    const manifestSources = selected.flatMap((candidate) => {
      if (candidate.category !== "atom_ref" || !candidate.sourceManifest) return [];
      const observed = budgetedById.get(candidateBudgetId(candidate));
      const chars = observed?.content?.length ?? 0;
      return [{
        ...candidate.sourceManifest,
        chars,
        token_estimate: Math.ceil(chars / 4),
        truncated: candidate.sourceManifest.truncated || observed?.truncated === true,
        anchor_count: observed?.anchorCount ?? candidate.sourceManifest.anchor_count,
      }];
    });
    return {
      contextItem,
      contextManifest: contextManifestFromSources(manifestSources),
    };
  }
}

function candidateBudgetId(candidate: PageContextCandidate): string {
  return candidate.category === "atom_ref"
    ? candidate.sourceManifest?.id ?? candidate.semanticKey
    : candidate.semanticKey;
}

export function selectNearestPageContextCandidates(
  candidates: PageContextCandidate[],
): PageContextCandidate[] {
  const selected = new Map<string, PageContextCandidate>();
  for (const candidate of [...candidates].sort(compareNearFirst)) {
    if (!selected.has(candidate.semanticKey)) selected.set(candidate.semanticKey, candidate);
  }
  return [...selected.values()];
}

function compareNearFirst(a: PageContextCandidate, b: PageContextCandidate): number {
  return a.distance - b.distance || compareStable(a, b);
}

function compareRootToLeaf(a: PageContextCandidate, b: PageContextCandidate): number {
  return b.distance - a.distance || compareStable(a, b);
}

function compareStable(a: PageContextCandidate, b: PageContextCandidate): number {
  return comparePositionKeys(a.positionKey, b.positionKey)
    || compareLexicographically(a.blockId, b.blockId)
    || compareLexicographically(a.pageId, b.pageId);
}
