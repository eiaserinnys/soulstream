import type { Logger } from "pino";
import type {
  BacklinkDto,
  BlockDto,
  BlockOperationDto,
  PageDto,
  PageActorKind,
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

export interface PageClientActor {
  actorKind?: PageActorKind;
  actorSessionId: string | null;
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

  async createPage(input: {
    page: { id: string; title: string; daily_date: string | null; metadata?: Record<string, unknown> };
    blocks?: PageMarkdownBlockInput[];
    actorKind?: PageActorKind;
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<PageMutationResult> {
    return await this.request("create-page", {
      page: input.page,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...actor(input, input.idempotencyKey),
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

  async replacePageMarkdown(input: {
    pageId: string;
    expectedVersion: number;
    blocks: PageMarkdownBlockInput[];
    actorKind?: PageActorKind;
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<PageMutationResult> {
    return await this.request("replace-page-markdown", {
      page_id: input.pageId,
      expected_version: input.expectedVersion,
      blocks: input.blocks,
      ...actor(input, input.idempotencyKey),
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
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/page-yjs/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
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

function actor(input: PageClientActor, idempotencyKey: string) {
  return {
    actor_kind: input.actorKind ?? "agent",
    actor_session_id: input.actorSessionId,
    idempotency_key: idempotencyKey,
  };
}

async function responseErrorDetail(response: Response): Promise<{
  message: string;
  code: string | null;
  details: Record<string, unknown>;
}> {
  const text = await response.text();
  if (!text) {
    return { message: `${response.status} ${response.statusText}`, code: null, details: {} };
  }
  try {
    const detail = (JSON.parse(text) as {
      detail?: { error?: { message?: unknown; code?: unknown; details?: unknown } };
    }).detail;
    if (typeof detail?.error?.message === "string") {
      const details = detail.error.details;
      return {
        message: detail.error.message,
        code: typeof detail.error.code === "string" ? detail.error.code : null,
        details: details !== null && typeof details === "object" && !Array.isArray(details)
          ? details as Record<string, unknown>
          : {},
      };
    }
  } catch {
    return { message: text, code: null, details: {} };
  }
  return { message: text, code: null, details: {} };
}
