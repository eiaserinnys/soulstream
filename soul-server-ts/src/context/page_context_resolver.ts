import type { Logger } from "pino";
import { compareLexicographically } from "@soulstream/fractional-position";

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
  resolve(task: Task, agent: AgentProfile): Promise<PageContextResolution>;
}

export class NoPageAnchorContextResolver implements PageContextResolver {
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

  async resolve(task: Task, _agent: AgentProfile): Promise<PageContextResolution> {
    let anchor: PageContextAnchor | null;
    try {
      anchor = await this.repository.getAnchor(task.agentSessionId);
    } catch (err) {
      this.logger.warn({ err, sessionId: task.agentSessionId }, "page context anchor lookup failed");
      return { kind: "no-page-anchor" };
    }
    if (!anchor) return { kind: "no-page-anchor" };

    const candidates: PageContextCandidate[] = [];
    const failures: PageContextTraversalFailure[] = [];
    const visited = new Set<string>();
    const queue: QueueEntry[] = [{ ...anchor, distance: 0 }];
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.pageId)) continue;
      if (visited.size >= this.maxPages) {
        truncated = true;
        break;
      }
      visited.add(current.pageId);
      let page;
      try {
        page = await this.repository.getPage(current.pageId);
      } catch (err) {
        failures.push(failure("page", current.pageId, err));
        this.logger.warn({ err, pageId: current.pageId }, "page context page read failed");
        continue;
      }
      const byId = new Map(page.blocks.map((block) => [block.id, block]));
      const entry = byId.get(current.blockId);
      if (!entry) {
        failures.push(failure("block", current.pageId, new Error("entry block missing"), current.blockId));
        continue;
      }
      collectPhysicalAncestors(byId, entry.parent_id, current.distance + 1, candidates, failures);
      try {
        const parents = await this.repository.listMountParents(current.pageId);
        truncated ||= parents.truncated;
        for (const parent of [...parents.items].sort(compareParents)) {
          queue.push({ ...parent, distance: current.distance + 1 });
        }
      } catch (err) {
        failures.push(failure("mounts", current.pageId, err));
        this.logger.warn({ err, pageId: current.pageId }, "page context mount lookup failed");
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
}

interface QueueEntry extends PageContextAnchor {
  distance: number;
}

function collectPhysicalAncestors(
  byId: Map<string, { id: string; parent_id: string | null; position_key: string; block_type: string; text: string; properties: Record<string, unknown>; page_id: string }>,
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
  block: { id: string; page_id: string; position_key: string; block_type: string; text: string; properties: Record<string, unknown> },
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
