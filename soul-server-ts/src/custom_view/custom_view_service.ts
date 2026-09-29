import { createHash } from "node:crypto";

import type {
  CatalogBoardItemRow,
  CustomViewRow,
  FolderRow,
} from "../db/session_db_types.js";
import {
  boardItemsDelta,
  serializeCatalogFolders,
  type CatalogBoardItemsDelta,
  type CatalogFolderRecord,
  type CatalogSessionsDelta,
} from "../catalog/catalog_delta.js";
import {
  CustomViewRevisionConflictError,
  type CustomViewProjectionHost,
  type CustomViewWithBoardItem,
} from "./custom_view_contract.js";

export { CustomViewRevisionConflictError };

export interface CustomViewDbPort {
  getAllFolders(): Promise<FolderRow[]>;
}

export interface CustomViewBoardYjsPort extends CustomViewProjectionHost {
  upsertCustomViewBoardItem(input: {
    folderId: string;
    boardItemId: string;
    customViewId: string;
    title: string;
    html: string;
    revision: number;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  }): Promise<CatalogBoardItemRow>;
  removeBoardItem(folderId: string, boardItemId: string): Promise<void>;
}

export interface CustomViewBroadcasterPort {
  emitCatalogUpdated?(
    folders: readonly CatalogFolderRecord[],
    sessionsDelta: CatalogSessionsDelta,
    boardItemsDelta: CatalogBoardItemsDelta,
  ): Promise<void>;
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
  eventId?: number | null;
  idempotent?: boolean;
}

export interface CustomViewActor {
  actorKind: "agent" | "user" | "system" | "llm";
  actorSessionId: string | null;
}

export class CustomViewService {
  constructor(
    private readonly db: CustomViewDbPort,
    private readonly boardYjsService: CustomViewBoardYjsPort,
    private readonly broadcaster?: CustomViewBroadcasterPort,
  ) {}

  async createCustomView(params: CustomViewActor & {
    folderId: string;
    title: string;
    html: string;
    x?: number;
    y?: number;
    idempotencyKey: string;
  }): Promise<CustomViewMutationResult> {
    await this.requireFolder(params.folderId);
    const customViewId = customViewIdForIdempotencyKey(params.idempotencyKey);
    const existing = await this.boardYjsService.getCustomView(customViewId);
    if (existing) {
      return { ...existing, idempotent: true };
    }

    const title = normalizeTitle(params.title);
    const html = params.html;
    const boardItemId = `custom_view:${customViewId}`;
    const boardItem = await this.boardYjsService.upsertCustomViewBoardItem({
      folderId: params.folderId,
      boardItemId,
      customViewId,
      title,
      html,
      revision: 1,
      x: params.x ?? 0,
      y: params.y ?? 0,
    });
    try {
      const { customView, eventId } = await this.boardYjsService.createCustomViewRecord({
        id: customViewId,
        boardItemId,
        title,
        html,
        actorKind: params.actorKind,
        actorSessionId: params.actorSessionId,
        idempotencyKey: params.idempotencyKey,
      });
      const result = { customView, boardItem, eventId };
      await this.broadcast(params.actorSessionId, result);
      return result;
    } catch (err) {
      await this.boardYjsService.removeBoardItem(params.folderId, boardItemId)
        .catch(() => undefined);
      throw err;
    }
  }

  async patchCustomView(params: CustomViewActor & {
    customViewId: string;
    expectedRevision: number;
    html: string;
    title?: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewMutationResult> {
    const existing = await this.boardYjsService.getCustomView(params.customViewId);
    if (!existing) throw new Error(`custom view not found: ${params.customViewId}`);
    if (isIdempotentPatchRetry(existing.customView, params)) {
      return { ...existing, idempotent: true };
    }

    const { customView, eventId } = await this.boardYjsService.patchCustomViewRecord({
      customViewId: params.customViewId,
      boardItemId: existing.boardItem.id,
      expectedRevision: params.expectedRevision,
      html: params.html,
      ...(Object.prototype.hasOwnProperty.call(params, "title")
        ? { title: params.title ?? null }
        : {}),
      actorKind: params.actorKind,
      actorSessionId: params.actorSessionId,
      idempotencyKey: params.idempotencyKey,
    });

    const boardItem = await this.boardYjsService.upsertCustomViewBoardItem({
      folderId: existing.boardItem.folderId,
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
    return await this.boardYjsService.getCustomView(customViewId);
  }

  async listCustomViews(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]> {
    await this.requireFolder(params.folderId);
    return await this.boardYjsService.listCustomViews(params);
  }

  private async requireFolder(folderId: string): Promise<void> {
    if (!(await this.db.getAllFolders()).some((folder) => folder.id === folderId)) {
      throw new Error(`folder not found: ${folderId}`);
    }
  }

  private async broadcast(
    actorSessionId: string | null,
    result: CustomViewMutationResult,
  ): Promise<void> {
    if (result.idempotent) return;
    await this.broadcaster?.emitCatalogUpdated?.(
      serializeCatalogFolders(await this.db.getAllFolders()),
      {},
      boardItemsDelta([result.boardItem]),
    );
    if (actorSessionId) {
      await this.broadcaster?.emitCustomViewUpdated?.(
        actorSessionId,
        result.customView.id,
        result.boardItem.id,
        result.customView.revision,
      );
    }
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
