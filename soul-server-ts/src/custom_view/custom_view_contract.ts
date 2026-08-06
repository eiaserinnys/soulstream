import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  CustomViewRow,
} from "../db/session_db_types.js";

export interface CustomViewWithBoardItem {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
}

export interface CustomViewRecordMutationResult {
  customView: CustomViewRow;
  eventId: number | null;
}

export class CustomViewRevisionConflictError extends Error {
  readonly customViewId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(customViewId: string, expectedRevision: number, actualRevision: number) {
    super(
      `custom view revision conflict for ${customViewId}: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "CustomViewRevisionConflictError";
    this.customViewId = customViewId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface CustomViewProjectionHost {
  getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null>;
  listCustomViews(params: {
    container: BoardYjsContainerRef;
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
