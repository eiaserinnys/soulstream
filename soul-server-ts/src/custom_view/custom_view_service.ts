import { createHash } from "node:crypto";

import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
  CustomViewRow,
} from "../db/session_db_types.js";
import type {
  CustomViewRepository,
  CustomViewWithBoardItem,
} from "../db/repositories/custom_view_repository.js";
import {
  CustomViewRevisionConflictError,
} from "../db/repositories/custom_view_repository.js";
import type { AppendEventParams } from "../db/session_db_types.js";
import type { RepositorySql } from "../db/repositories/repository_helpers.js";

export { CustomViewRevisionConflictError };

export interface CustomViewDbPort {
  customViews(): CustomViewRepository;
  appendEventTx(sql: RepositorySql, params: AppendEventParams): Promise<number>;
  getCatalog(): Promise<unknown>;
  resolveBoardYjsContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null>;
}

export interface CustomViewBoardYjsPort {
  upsertCustomViewBoardItem(input: {
    folderId: string;
    container: BoardYjsContainerRef;
    boardItemId: string;
    customViewId: string;
    title: string;
    html: string;
    revision: number;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow>;
  removeBoardItem(container: BoardYjsContainerRef, boardItemId: string): Promise<void>;
}

export interface CustomViewBroadcasterPort {
  emitCatalogUpdated?(catalog: unknown): Promise<void>;
  emitCustomViewUpdated?(
    actorSessionId: string,
    customViewId: string,
    boardItemId: string,
    revision: number,
  ): Promise<void>;
}

export interface CustomViewMutationResult {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
  eventId?: number;
  idempotent?: boolean;
}

export class CustomViewService {
  private readonly repo: CustomViewRepository;

  constructor(
    private readonly db: CustomViewDbPort,
    private readonly boardYjsService: CustomViewBoardYjsPort,
    private readonly broadcaster?: CustomViewBroadcasterPort,
  ) {
    this.repo = db.customViews();
  }

  async createCustomView(params: {
    actorSessionId: string;
    container: BoardYjsContainerRef;
    title: string;
    html: string;
    x?: number;
    y?: number;
    idempotencyKey: string;
  }): Promise<CustomViewMutationResult> {
    const scope = await this.requireContainerScope(params.container);
    const customViewId = customViewIdForIdempotencyKey(params.idempotencyKey);
    const existing = await this.repo.getCustomView(customViewId);
    if (existing) {
      return { ...existing, idempotent: true };
    }

    const title = normalizeTitle(params.title);
    const html = params.html;
    const boardItemId = `custom_view:${customViewId}`;
    const boardItem = await this.boardYjsService.upsertCustomViewBoardItem({
      folderId: scope.folderId,
      container: params.container,
      boardItemId,
      customViewId,
      title,
      html,
      revision: 1,
      x: params.x ?? 0,
      y: params.y ?? 0,
    });
    try {
      let customView!: CustomViewRow;
      let eventId = 0;
      await this.repo.transaction(async (sql) => {
        eventId = await this.appendEvent(sql, {
          actorSessionId: params.actorSessionId,
          eventType: "custom_view_created",
          customViewId,
          boardItemId,
          revision: 1,
          idempotencyKey: params.idempotencyKey,
          searchableText: `custom view created ${title}`,
        });
        customView = await this.repo.createCustomViewTx(sql, {
          id: customViewId,
          boardItemId,
          title,
          html,
          actorSessionId: params.actorSessionId,
          eventId,
        });
      });
      const result = { customView, boardItem, eventId };
      await this.broadcast(params.actorSessionId, result);
      return result;
    } catch (err) {
      await this.boardYjsService.removeBoardItem(params.container, boardItemId)
        .catch(() => undefined);
      throw err;
    }
  }

  async patchCustomView(params: {
    actorSessionId: string;
    customViewId: string;
    expectedRevision: number;
    html: string;
    title?: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewMutationResult> {
    const existing = await this.repo.getCustomView(params.customViewId);
    if (!existing) throw new Error(`custom view not found: ${params.customViewId}`);
    if (isIdempotentPatchRetry(existing.customView, params)) {
      return { ...existing, idempotent: true };
    }

    let customView!: CustomViewRow;
    let eventId = 0;
    await this.repo.transaction(async (sql) => {
      eventId = await this.appendEvent(sql, {
        actorSessionId: params.actorSessionId,
        eventType: "custom_view_updated",
        customViewId: params.customViewId,
        boardItemId: existing.boardItem.id,
        revision: params.expectedRevision + 1,
        idempotencyKey: params.idempotencyKey,
        searchableText: `custom view updated ${params.customViewId}`,
      });
      customView = await this.repo.patchCustomViewTx(sql, {
        customViewId: params.customViewId,
        expectedRevision: params.expectedRevision,
        html: params.html,
        ...(Object.prototype.hasOwnProperty.call(params, "title")
          ? { title: params.title ?? null }
          : {}),
        actorSessionId: params.actorSessionId,
        eventId,
      });
    });

    const boardItem = await this.boardYjsService.upsertCustomViewBoardItem({
      folderId: existing.boardItem.folderId,
      container: {
        containerKind: existing.boardItem.containerKind ?? "folder",
        containerId: existing.boardItem.containerId ?? existing.boardItem.folderId,
      },
      boardItemId: existing.boardItem.id,
      customViewId: customView.id,
      title: customView.title ?? "Custom view",
      html: customView.html,
      revision: customView.revision,
      x: existing.boardItem.x,
      y: existing.boardItem.y,
      metadata: existing.boardItem.metadata,
    });
    const result = { customView, boardItem, eventId };
    await this.broadcast(params.actorSessionId, result);
    return result;
  }

  async getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null> {
    return await this.repo.getCustomView(customViewId);
  }

  async listCustomViews(params: {
    container: BoardYjsContainerRef;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]> {
    await this.requireContainerScope(params.container);
    return await this.repo.listCustomViews(params);
  }

  private async requireContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope> {
    const scope = await this.db.resolveBoardYjsContainerScope(container);
    if (!scope) {
      throw new Error(`board container not found: ${container.containerKind}:${container.containerId}`);
    }
    return scope;
  }

  private async appendEvent(
    sql: RepositorySql,
    params: {
      actorSessionId: string;
      eventType: "custom_view_created" | "custom_view_updated";
      customViewId: string;
      boardItemId: string;
      revision: number;
      idempotencyKey: string;
      searchableText: string;
    },
  ): Promise<number> {
    return await this.db.appendEventTx(sql, {
      sessionId: params.actorSessionId,
      eventType: params.eventType,
      payload: JSON.stringify({
        custom_view_id: params.customViewId,
        board_item_id: params.boardItemId,
        revision: params.revision,
      }),
      searchableText: params.searchableText,
      createdAt: new Date(),
      dedupeKey: params.idempotencyKey,
    });
  }

  private async broadcast(
    actorSessionId: string,
    result: CustomViewMutationResult,
  ): Promise<void> {
    if (result.idempotent) return;
    await this.broadcaster?.emitCatalogUpdated?.(await this.db.getCatalog());
    await this.broadcaster?.emitCustomViewUpdated?.(
      actorSessionId,
      result.customView.id,
      result.boardItem.id,
      result.customView.revision,
    );
  }
}

function customViewIdForIdempotencyKey(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
  return `custom-view-${digest}`;
}

function normalizeTitle(title: string): string {
  return title.trim() || "Custom view";
}

function isIdempotentPatchRetry(
  current: CustomViewRow,
  params: {
    expectedRevision: number;
    html: string;
    title?: string | null;
  },
): boolean {
  if (current.revision !== params.expectedRevision + 1) return false;
  if (current.html !== params.html) return false;
  if (!Object.prototype.hasOwnProperty.call(params, "title")) return true;
  return (current.title ?? null) === (params.title ?? null);
}
