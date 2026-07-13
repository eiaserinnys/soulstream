import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";

import type { ContextItem } from "./prompt_assembler.js";
import type { PageContextAnchor } from "./page_context_repository.js";

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
  assemble(anchor: PageContextAnchor, traversal: PageContextTraversal): ContextItem;
}

export const DEFAULT_PAGE_CONTEXT_BUDGETS: PageContextBudgets = {
  guidanceChars: 8_000,
  atomRefChars: 4_000,
  sessionDefaultsChars: 0,
  totalChars: 10_000,
};

export class DefaultPageContextAssembler implements PageContextAssembler {
  private readonly budgets: PageContextBudgets;

  constructor(budgets: Partial<PageContextBudgets> = {}) {
    this.budgets = { ...DEFAULT_PAGE_CONTEXT_BUDGETS, ...budgets };
  }

  assemble(anchor: PageContextAnchor, traversal: PageContextTraversal): ContextItem {
    const selected = selectNearest(traversal.candidates);
    const usage = {
      guidance: { limit: this.budgets.guidanceChars, used: 0, omitted: 0 },
      atom_ref: { limit: this.budgets.atomRefChars, used: 0, omitted: 0 },
      session_defaults: { limit: this.budgets.sessionDefaultsChars, used: 0, omitted: 0 },
      total: { limit: this.budgets.totalChars, used: 0, omitted: 0 },
    };
    const rendered: Array<Record<string, unknown> & { candidate: PageContextCandidate }> = [];
    for (const candidate of [...selected].sort(compareNearFirst)) {
      if (candidate.category === "session_defaults") {
        usage.session_defaults.omitted += 1;
        continue;
      }
      const category = usage[candidate.category];
      const categoryRemaining = Math.max(0, category.limit - category.used);
      const totalRemaining = Math.max(0, usage.total.limit - usage.total.used);
      const cost = candidate.category === "guidance"
        ? candidate.text.length
        : candidate.nodeId.length;
      const available = Math.min(categoryRemaining, totalRemaining);
      if (available <= 0 || (candidate.category === "atom_ref" && available < cost)) {
        category.omitted += 1;
        usage.total.omitted += 1;
        continue;
      }
      const used = Math.min(cost, available);
      const truncated = used < cost;
      category.used += used;
      usage.total.used += used;
      if (truncated) {
        category.omitted += 1;
        usage.total.omitted += 1;
      }
      rendered.push({
        candidate,
        category: candidate.category,
        semantic_key: candidate.semanticKey,
        page_id: candidate.pageId,
        block_id: candidate.blockId,
        ...(candidate.category === "guidance"
          ? {
              scope: candidate.scope,
              text: candidate.text.slice(0, used),
              ...(truncated ? { truncated: true } : {}),
            }
          : { instance: candidate.instance, node_id: candidate.nodeId }),
      });
    }
    const items = rendered
      .sort((a, b) => compareRootToLeaf(a.candidate, b.candidate))
      .map(({ candidate: _candidate, ...entry }) => entry);
    return {
      key: "page_context",
      label: "Page ancestor context",
      content: {
        anchor: { page_id: anchor.pageId, block_id: anchor.blockId },
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
            categories: {
              guidance: usage.guidance,
              atom_ref: usage.atom_ref,
              session_defaults: usage.session_defaults,
            },
            total: usage.total,
          },
        },
      },
    };
  }
}

function selectNearest(candidates: PageContextCandidate[]): PageContextCandidate[] {
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
