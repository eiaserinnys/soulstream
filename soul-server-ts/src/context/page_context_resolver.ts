import type { Logger } from "pino";
import {
  compareLexicographically,
  comparePositionKeys,
} from "@soulstream/fractional-position";
import type { BlockDto } from "@soulstream/page-model";

import type { AgentProfile } from "../agent_registry.js";
import type { Task } from "../task/task_models.js";
import type { ContextItem } from "./prompt_assembler.js";
import type {
  PageContextAssembler,
  PageContextCandidate,
  PageContextTraversalFailure,
} from "./page_context_assembler.js";
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

/** Boundary for resolving page-owned context before the first engine turn. */
export interface PageContextResolver {
  hasPageAnchor(task: Task, agent: AgentProfile): Promise<boolean>;
  resolve(task: Task, agent: AgentProfile): Promise<PageContextResolution>;
}

export class NoPageAnchorContextResolver implements PageContextResolver {
  async hasPageAnchor(_task: Task, _agent: AgentProfile): Promise<boolean> {
    return false;
  }

  async resolve(_task: Task, _agent: AgentProfile): Promise<NoPageAnchorContext> {
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

  async resolve(task: Task, _agent: AgentProfile): Promise<PageContextResolution> {
    const anchor = await this.lookupAnchor(task);
    if (!anchor) return { kind: "no-page-anchor" };

    const candidates: PageContextCandidate[] = [];
    const failures: PageContextTraversalFailure[] = [];
    const visited = new Set<string>();
    const queue: QueueEntry[] = [{ ...anchor, distance: 0 }];
    let truncated = false;
    while (queue.length > 0) {
      const first = queue.shift()!;
      const entries = takeEquivalentEntries(first, queue);
      if (visited.has(first.pageId)) continue;
      if (visited.size >= this.maxPages) {
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
    return {
      kind: "page-anchor",
      contextItem: this.assembler.assemble(anchor, {
        candidates,
        visitedPages: visited.size,
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
  if (block.block_type !== "atom_ref") return null;
  const instance = block.properties.instance;
  const nodeId = block.properties.nodeId;
  if ((instance !== "atom" && instance !== "atom-nl") || typeof nodeId !== "string" || !nodeId) {
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
  };
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
