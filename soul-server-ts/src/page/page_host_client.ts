import type { Logger } from "pino";
import type {
  BacklinkDto,
  BlockDto,
  BlockOperationDto,
  PageDto,
  PageLinkKind,
  PageMarkdownBlockInput,
} from "@soulstream/page-model";

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

export class PageYjsHostClient {
  constructor(private readonly config: PageYjsHostClientConfig) {}

  async getPage(pageId: string, includeBlocks: boolean): Promise<{ page: PageDto; blocks?: BlockDto[] }> {
    return await this.request("get-page", { page_id: pageId, include_blocks: includeBlocks });
  }

  async findPage(title: string): Promise<{ page: PageDto | null }> {
    return await this.request("find-page", { title });
  }

  async getBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    limit: number;
  }): Promise<{ items: BacklinkDto[]; next_cursor: string | null }> {
    return await this.request("get-backlinks", {
      page_id: input.pageId,
      kinds: input.kinds,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    });
  }

  async createPage(input: {
    page: { id: string; title: string; daily_date: string | null; metadata?: Record<string, unknown> };
    blocks?: PageMarkdownBlockInput[];
    actorSessionId: string;
    idempotencyKey: string;
  }): Promise<PageMutationResult> {
    return await this.request("create-page", {
      page: input.page,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...actor(input.actorSessionId, input.idempotencyKey),
    });
  }

  async batchPageOperations(input: Record<string, unknown> & {
    actor_session_id: string;
    idempotency_key: string;
  }): Promise<PageMutationResult> {
    return await this.request("batch-page-operations", {
      ...input,
      actor_kind: "agent",
    });
  }

  async replacePageMarkdown(input: {
    pageId: string;
    expectedVersion: number;
    blocks: PageMarkdownBlockInput[];
    actorSessionId: string;
    idempotencyKey: string;
  }): Promise<PageMutationResult> {
    return await this.request("replace-page-markdown", {
      page_id: input.pageId,
      expected_version: input.expectedVersion,
      blocks: input.blocks,
      ...actor(input.actorSessionId, input.idempotencyKey),
    });
  }

  async getDailyPage(input: {
    date?: string;
    actorSessionId: string;
  }): Promise<{ page: PageDto; created: boolean; operation?: BlockOperationDto }> {
    return await this.request("get-daily-page", {
      ...(input.date ? { date: input.date } : {}),
      actor_kind: "agent",
      actor_session_id: input.actorSessionId,
    });
  }

  private async request<T>(operation: string, body: unknown): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/page-yjs/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      this.config.logger.warn(
        { operation, status: response.status, message },
        "page Yjs host request failed",
      );
      throw new Error(`page Yjs host ${operation} failed: ${message}`);
    }
    return await response.json() as T;
  }
}

function actor(actorSessionId: string, idempotencyKey: string) {
  return {
    actor_kind: "agent" as const,
    actor_session_id: actorSessionId,
    idempotency_key: idempotencyKey,
  };
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const detail = (JSON.parse(text) as { detail?: { error?: { message?: unknown } } }).detail;
    if (typeof detail?.error?.message === "string") return detail.error.message;
  } catch {
    return text;
  }
  return text;
}
