import type {
  CatalogBoardItemRow,
  CustomViewRow,
} from "@soulstream/wire-schema/catalog";

export interface CustomViewWithBoardItem {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
}

export interface CustomViewRecordMutationResult {
  customView: CustomViewRow;
  eventId: number | null;
}

export interface CustomViewProjectionHost {
  getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null>;
  listCustomViews(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]>;
  createCustomViewRecord(input: {
    id: string;
    boardItemId: string;
    title: string;
    html: string;
    actorKind: CustomViewRow["createdActorKind"];
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewRecordMutationResult>;
  patchCustomViewRecord(input: {
    customViewId: string;
    boardItemId: string;
    expectedRevision: number;
    html: string;
    title?: string | null;
    actorKind: CustomViewRow["updatedActorKind"];
    actorSessionId: string | null;
    idempotencyKey: string;
  }): Promise<CustomViewRecordMutationResult>;
}
