import type {
  BacklinkDto,
  BlockDto,
  BlockOperationDto,
  PageActorKind,
  PageDto,
  PageLinkKind
} from "@soulstream/page-model";
import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface PageYjsHostClientConfig {
  orch: OrchProxyConfig;
  logger: Logger;
}

export interface PageMutationResult {
  page: PageDto;
  blocks: BlockDto[];
  temp_id_mapping: Record<string, string>;
  operation: BlockOperationDto;
  idempotent?: boolean;
}

export class PageYjsHostClientError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PageYjsHostClientError";
  }
}

export class PageYjsHostClient {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: PageYjsHostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  async getPage(pageId: string, includeBlocks: boolean): Promise<{ page: PageDto; blocks?: BlockDto[] }> {
    return await this.request("get-page", { page_id: pageId, include_blocks: includeBlocks });
  }

  async getBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    includeSelf?: boolean;
    limit: number;
  }): Promise<{ items: BacklinkDto[]; next_cursor: string | null }> {
    return await this.request("get-backlinks", {
      page_id: input.pageId,
      kinds: input.kinds,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      include_self: input.includeSelf ?? false,
      limit: input.limit,
    });
  }

  async batchPageOperations(input: Record<string, unknown> & {
    actor_kind?: PageActorKind;
    actor_session_id: string | null;
    idempotency_key: string;
  }): Promise<PageMutationResult> {
    return await this.request("batch-page-operations", {
      ...input,
      actor_kind: input.actor_kind ?? "agent",
    });
  }

  async getDailyPage(input: {
    date?: string;
    actorKind?: PageActorKind;
    actorSessionId: string | null;
  }): Promise<{ page: PageDto; created: boolean; operation?: BlockOperationDto }> {
    return await this.request("get-daily-page", {
      ...(input.date ? { date: input.date } : {}),
      actor_kind: input.actorKind ?? "agent",
      actor_session_id: input.actorSessionId,
    });
  }

  private async request<T>(operation: string, body: unknown): Promise<T> {
    const response = await this.transport.send(
      "POST",
      `/api/page-yjs/host/${encodeURIComponent(operation)}`,
      body,
    );
    if (!response.ok) {
      const detail = await readOrchErrorEnvelope(response);
      this.config.logger.warn(
        { operation, status: response.status, message: detail.message, code: detail.code },
        "page Yjs host request failed",
      );
      throw new PageYjsHostClientError(
        detail.code,
        response.status,
        `page Yjs host ${operation} failed: ${detail.message}`,
        detail.details,
      );
    }
    return await response.json() as T;
  }
}
