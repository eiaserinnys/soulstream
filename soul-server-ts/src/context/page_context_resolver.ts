import type { Logger } from "pino";
import {
  compareLexicographically,
  comparePositionKeys,
} from "@soulstream/fractional-position";
import type { BlockDto } from "@soulstream/page-model";

import type { AgentProfile } from "../agent_registry.js";
import type { Task } from "../task/task_models.js";
import type { ContextItem } from "./prompt_assembler.js";
import {
  fetchAtomContext,
  type AtomFetchConfig,
} from "./atom_context.js";
import type {
  AtomRefPageContextCandidate,
  PageContextAssembler,
  PageContextCandidate,
  PageContextTraversalFailure,
} from "./page_context_assembler.js";
import { selectNearestPageContextCandidates } from "./page_context_assembler.js";
import type {
  PageContextAnchor,
  PageContextRepository,
} from "./page_context_repository.js";

/** Neutral result used until a session has a durable page anchor. */
export interface NoPageAnchorContext {
  kind: "no-page-anchor";
}

export interface PageAnchorContext {
  kind: "page-anchor";
  contextItem: ContextItem;
}

export type PageContextResolution = NoPageAnchorContext | PageAnchorContext;

export const PAGE_CONTEXT_SOURCES_KEY = "page_context_sources";

/** Boundary for resolving page-owned context before the first engine turn. */
export interface PageContextResolver {
  hasPageAnchor(task: Task, agent: AgentProfile): Promise<boolean>;
  resolve(
    task: Task,
    agent: AgentProfile,
    atomConfig?: AtomFetchConfig,
  ): Promise<PageContextResolution>;
}

export class NoPageAnchorContextResolver implements PageContextResolver {
  async hasPageAnchor(_task: Task, _agent: AgentProfile): Promise<boolean> {
    return false;
  }

  async resolve(
    _task: Task,
    _agent: AgentProfile,
    _atomConfig?: AtomFetchConfig,
  ): Promise<NoPageAnchorContext> {
    return { kind: "no-page-anchor" };
  }
}

export const NO_PAGE_ANCHOR_CONTEXT_RESOLVER: PageContextResolver =
  new NoPageAnchorContextResolver();

export class AncestorPageContextResolver implements PageContextResolver {
  constructor(
    private readonly repository: PageContextRepository,
    private readonly assembler: PageContextAssembler,
    private readonly logger: Pick<Logger, "warn">,
    private readonly maxPages = 64,
  ) {}

  async hasPageAnchor(task: Task, _agent: AgentProfile): Promise<boolean> {
    return (await this.lookupAnchor(task)) !== null;
  }

  async resolve(
    task: Task,
    _agent: AgentProfile,
    atomConfig?: AtomFetchConfig,
  ): Promise<PageContextResolution> {
    const anchor = await this.lookupAnchor(task);
    if (!anchor) return { kind: "no-page-anchor" };

    const candidates: PageContextCandidate[] = [];
    const failures: PageContextTraversalFailure[] = [];
    const explicitPageLimit = Math.max(0, this.maxPages - 1);
    const sourcePageIds = pageContextSourceIds(task.contextItems);
    const explicitPageIds = explicitPageLimit > 0
      ? sourcePageIds.slice(-explicitPageLimit)
      : [];
    await collectExplicitPageContexts(
      this.repository,
      explicitPageIds,
      candidates,
      failures,
      this.logger,
    );
    const visited = new Set<string>();
    const queue: QueueEntry[] = [{ ...anchor, distance: 0 }];
    const traversalLimit = Math.max(1, this.maxPages - explicitPageIds.length);
    let truncated = false;
    while (queue.length > 0) {
      const first = queue.shift()!;
      const entries = takeEquivalentEntries(first, queue);
      if (visited.has(first.pageId)) continue;
      if (visited.size >= traversalLimit) {
        truncated = true;
        break;
      }
      visited.add(first.pageId);
      try {
        const page = await this.repository.getPage(first.pageId);
        const byId = new Map(page.blocks.map((block) => [block.id, block]));
        const entry = selectCanonicalEntry(entries, byId, first.pageId, failures);
        if (entry) {
          collectPhysicalAncestors(
            byId,
            entry.parent_id,
            first.distance + 1,
            candidates,
            failures,
          );
        }
      } catch (err) {
        failures.push(failure("page", first.pageId, err));
        this.logger.warn({ err, pageId: first.pageId }, "page context page read failed");
      }
      try {
        const parents = await this.repository.listMountParents(first.pageId);
        truncated ||= parents.truncated;
        for (const parent of [...parents.items].sort(compareParents)) {
          queue.push({ ...parent, distance: first.distance + 1 });
        }
      } catch (err) {
        failures.push(failure("mounts", first.pageId, err));
        this.logger.warn({ err, pageId: first.pageId }, "page context mount lookup failed");
      }
    }
    const enrichedCandidates = await enrichAtomRefCandidates(
      candidates,
      atomConfig,
      this.logger,
    );
    return {
      kind: "page-anchor",
      contextItem: this.assembler.assemble(anchor, {
        candidates: enrichedCandidates,
        visitedPages: new Set([...visited, ...explicitPageIds]).size,
        failures,
        truncated,
      }),
    };
  }

  private async lookupAnchor(task: Task): Promise<PageContextAnchor | null> {
    try {
      return await this.repository.getAnchor(task.agentSessionId);
    } catch (err) {
      this.logger.warn({ err, sessionId: task.agentSessionId }, "page context anchor lookup failed");
      return null;
    }
  }
}

export function isPageContextSourcesItem(item: ContextItem): boolean {
  return item.key === PAGE_CONTEXT_SOURCES_KEY;
}

/** page_context_sources 마커는 resolver 입력 전용 — 엔진 컨텍스트로 흘리지 않는다. */
export function withoutPageContextSources(items: ContextItem[] | undefined): ContextItem[] {
  return (items ?? []).filter((item) => !isPageContextSourcesItem(item));
}

function pageContextSourceIds(items: ContextItem[] | undefined): string[] {
  const marker = items?.find(isPageContextSourcesItem);
  if (!marker || !isRecord(marker.content) || !Array.isArray(marker.content.pages)) return [];
  const seen = new Set<string>();
  return marker.content.pages.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pageId = typeof entry.page_id === "string" ? entry.page_id.trim() : "";
    if (!pageId || seen.has(pageId)) return [];
    seen.add(pageId);
    return [pageId];
  });
}

async function collectExplicitPageContexts(
  repository: PageContextRepository,
  pageIds: readonly string[],
  output: PageContextCandidate[],
  failures: PageContextTraversalFailure[],
  logger: Pick<Logger, "warn">,
): Promise<void> {
  for (const [index, pageId] of pageIds.entries()) {
    try {
      const page = await repository.getPage(pageId);
      const distance = pageIds.length - index;
      for (const block of page.blocks) {
        if (block.parent_id !== null) continue;
        const candidate = toCandidate(block, distance);
        if (candidate) output.push(candidate);
      }
    } catch (err) {
      failures.push(failure("page", pageId, err));
      logger.warn({ err, pageId }, "explicit page context read failed");
    }
  }
}

interface QueueEntry extends PageContextAnchor {
  distance: number;
}

function takeEquivalentEntries(first: QueueEntry, queue: QueueEntry[]): QueueEntry[] {
  const entries = [first];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const candidate = queue[index]!;
    if (candidate.pageId === first.pageId && candidate.distance === first.distance) {
      entries.push(candidate);
      queue.splice(index, 1);
    }
  }
  return entries;
}

function selectCanonicalEntry(
  entries: QueueEntry[],
  byId: Map<string, BlockDto>,
  pageId: string,
  failures: PageContextTraversalFailure[],
): BlockDto | null {
  const found = new Map<string, BlockDto>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.blockId)) continue;
    seen.add(entry.blockId);
    const block = byId.get(entry.blockId);
    if (block) {
      found.set(block.id, block);
    } else {
      failures.push(failure("block", pageId, new Error("entry block missing"), entry.blockId));
    }
  }
  return [...found.values()].sort(compareEntryBlocks)[0] ?? null;
}

function compareEntryBlocks(a: BlockDto, b: BlockDto): number {
  return comparePositionKeys(a.position_key, b.position_key)
    || compareLexicographically(a.id, b.id);
}

function collectPhysicalAncestors(
  byId: Map<string, BlockDto>,
  firstParentId: string | null,
  firstDistance: number,
  output: PageContextCandidate[],
  failures: PageContextTraversalFailure[],
): void {
  const seen = new Set<string>();
  let blockId = firstParentId;
  let distance = firstDistance;
  while (blockId) {
    if (seen.has(blockId)) {
      const block = byId.get(blockId);
      failures.push(failure("block", block?.page_id ?? "unknown", new Error("physical ancestor cycle"), blockId));
      break;
    }
    seen.add(blockId);
    const block = byId.get(blockId);
    if (!block) {
      failures.push(failure("block", "unknown", new Error("physical ancestor missing"), blockId));
      break;
    }
    const candidate = toCandidate(block, distance);
    if (candidate) output.push(candidate);
    blockId = block.parent_id;
    distance += 1;
  }
}

function toCandidate(
  block: BlockDto,
  distance: number,
): PageContextCandidate | null {
  if (block.block_type === "guidance") {
    if (block.properties.enabled !== true || block.text.length === 0) return null;
    const scope = typeof block.properties.scope === "string" && block.properties.scope.trim()
      ? block.properties.scope.trim()
      : block.id;
    return {
      category: "guidance",
      semanticKey: `guidance:${scope}`,
      pageId: block.page_id,
      blockId: block.id,
      positionKey: block.position_key,
      distance,
      text: block.text,
      scope,
    };
  }
  if (block.block_type === "session_defaults") {
    const scope = typeof block.properties.scope === "string"
      ? block.properties.scope.trim()
      : "";
    if (!scope) return null;
    const agentId = typeof block.properties.agentId === "string"
      ? block.properties.agentId.trim()
      : "";
    const nodeId = typeof block.properties.nodeId === "string"
      ? block.properties.nodeId.trim()
      : "";
    return {
      category: "session_defaults",
      semanticKey: `session_defaults:${scope}`,
      pageId: block.page_id,
      blockId: block.id,
      positionKey: block.position_key,
      distance,
      scope,
      ...(agentId ? { agentId } : {}),
      ...(nodeId ? { nodeId } : {}),
    };
  }
  if (block.block_type !== "atom_ref") return null;
  const instance = block.properties.instance;
  const rawNodeId = block.properties.nodeId;
  const nodeId = typeof rawNodeId === "string" ? rawNodeId.trim() : "";
  if ((instance !== "atom" && instance !== "atom-nl") || !nodeId) {
    return null;
  }
  return {
    category: "atom_ref",
    semanticKey: `atom_ref:${instance}:${nodeId}`,
    pageId: block.page_id,
    blockId: block.id,
    positionKey: block.position_key,
    distance,
    instance,
    nodeId,
    depth: normalizeAtomDepth(block.properties.depth),
    titlesOnly: block.properties.titlesOnly === true,
  };
}

async function enrichAtomRefCandidates(
  candidates: PageContextCandidate[],
  atomConfig: AtomFetchConfig | undefined,
  logger: Pick<Logger, "warn">,
): Promise<PageContextCandidate[]> {
  if (!atomConfig) return candidates;
  const selected = selectNearestPageContextCandidates(candidates).filter(
    (candidate): candidate is AtomRefPageContextCandidate => candidate.category === "atom_ref",
  );
  const compiled = await Promise.all(selected.map(async (candidate) => {
    try {
      const text = await fetchAtomContext(
        atomConfig,
        candidate.nodeId,
        candidate.depth,
        candidate.titlesOnly,
        logger,
      );
      return [candidate, text] as const;
    } catch (err) {
      logger.warn(
        { err, nodeId: candidate.nodeId, instance: candidate.instance },
        "page atom context compile failed",
      );
      return [candidate, null] as const;
    }
  }));
  const byCandidate = new Map<AtomRefPageContextCandidate, string>();
  for (const [candidate, text] of compiled) {
    if (text) byCandidate.set(candidate, text);
  }
  return candidates.map((candidate) => {
    if (candidate.category !== "atom_ref") return candidate;
    const compiledText = byCandidate.get(candidate);
    return compiledText ? { ...candidate, compiledText } : candidate;
  });
}

function normalizeAtomDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

function failure(
  stage: PageContextTraversalFailure["stage"],
  pageId: string,
  err: unknown,
  blockId?: string,
): PageContextTraversalFailure {
  return {
    stage,
    pageId,
    ...(blockId ? { blockId } : {}),
    message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
  };
}

function compareParents(a: PageContextAnchor, b: PageContextAnchor): number {
  return compareLexicographically(a.pageId, b.pageId)
    || compareLexicographically(a.blockId, b.blockId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
