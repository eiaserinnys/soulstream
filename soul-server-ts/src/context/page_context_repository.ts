import type { BlockDto, PageDto } from "@soulstream/page-model";
import { compareLexicographically } from "@soulstream/fractional-position";

import type { PageYjsHostClient } from "../page/page_host_client.js";
import type { SessionPageBindingRepository } from "../page/session_page_binding_repository.js";

export interface PageContextAnchor {
  pageId: string;
  blockId: string;
}

export interface PageContextPage {
  page: PageDto;
  blocks: BlockDto[];
}

export interface MountParent {
  pageId: string;
  blockId: string;
}

export interface MountParentResult {
  items: MountParent[];
  truncated: boolean;
}

export interface PageContextRepository {
  getAnchor(sessionId: string): Promise<PageContextAnchor | null>;
  getPage(pageId: string): Promise<PageContextPage>;
  listMountParents(pageId: string): Promise<MountParentResult>;
}

export class HostPageContextRepository implements PageContextRepository {
  constructor(
    private readonly bindings: Pick<SessionPageBindingRepository, "get">,
    private readonly pageHost: Pick<PageYjsHostClient, "getPage" | "getBacklinks">,
    private readonly maxMountParents = 1_000,
  ) {}

  async getAnchor(sessionId: string): Promise<PageContextAnchor | null> {
    const binding = await this.bindings.get(sessionId);
    if (!binding?.target_page_id || !binding.target_block_id) return null;
    return { pageId: binding.target_page_id, blockId: binding.target_block_id };
  }

  async getPage(pageId: string): Promise<PageContextPage> {
    const result = await this.pageHost.getPage(pageId, true);
    return { page: result.page, blocks: result.blocks ?? [] };
  }

  async listMountParents(pageId: string): Promise<MountParentResult> {
    const parents = new Map<string, MountParent>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    while (parents.size < this.maxMountParents) {
      const result = await this.pageHost.getBacklinks({
        pageId,
        kinds: ["mount"],
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      for (const item of result.items) {
        const parent = { pageId: item.source_page_id, blockId: item.source_block_id };
        parents.set(`${parent.pageId}:${parent.blockId}`, parent);
        if (parents.size >= this.maxMountParents) break;
      }
      if (!result.next_cursor) break;
      if (seenCursors.has(result.next_cursor) || parents.size >= this.maxMountParents) {
        truncated = true;
        break;
      }
      seenCursors.add(result.next_cursor);
      cursor = result.next_cursor;
    }
    return {
      items: [...parents.values()].sort((a, b) =>
        compareLexicographically(a.pageId, b.pageId)
          || compareLexicographically(a.blockId, b.blockId)),
      truncated,
    };
  }
}
