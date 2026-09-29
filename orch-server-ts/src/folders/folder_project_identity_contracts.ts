import type { BoardYjsService } from "../board-yjs/board_yjs_service.js";
import type { BoardYjsDocumentApplication } from "../board-yjs/board_yjs_types.js";
import type { InitialFolderContext } from "@soulstream/page-model";
import type {
  PageMutationActor,
  PageMutationApplication,
} from "../page/page_mutation_core.js";
import type { PageMutationCommitResult } from "../page/page_repository.js";
import type { PageUpdatedObserver } from "../page/page_update_notifications.js";

export interface FolderProjectRecord {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  projectPageId: string;
  archived: boolean;
  checklistEnabled: boolean;
  status: "open" | "completed";
  version: number;
  createdSessionId: string | null;
  createdEventId: number | null;
  createdAt: string;
  updatedAt: string;
  completedKind: string | null;
  completedSessionId: string | null;
  completedEventId: number | null;
  completedUserId: string | null;
  completedAt: string | null;
}

export interface FolderProjectBinding extends FolderProjectRecord {
  folderId: string;
  pageId: string;
  archived: boolean;
  pageVersion: number;
}

export interface FolderProjectUpdate {
  name?: string | null;
  sortOrder?: number | null;
  settings?: Record<string, unknown> | null;
  parentFolderId?: string | null;
}

export interface FolderProjectIdentityMutationResult {
  id: string;
  pageId: string;
  folder: FolderProjectRecord;
  operation: Record<string, unknown>;
  pageCommit: PageMutationCommitResult;
  idempotent?: boolean;
  parentPageUpdates?: { pageId: string; version: number }[];
}

export interface FolderProjectIdentityRepository {
  findMutationByIdempotencyKey(
    idempotencyKey: string,
    request: Record<string, unknown>,
  ): Promise<FolderProjectIdentityMutationResult | null>;
  create(input: {
    id: string;
    pageId: string;
    name: string;
    sortOrder: number;
    settings: Record<string, unknown>;
    parentFolderId: string | null;
    checklistEnabled: boolean;
    actor: PageMutationActor;
    idempotencyKey: string;
    request: Record<string, unknown>;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplications?: BoardYjsDocumentApplication[];
  }): Promise<FolderProjectIdentityMutationResult>;
  mutate(input: {
    binding: FolderProjectBinding;
    expectedVersion: number;
    title: string;
    archived: boolean;
    update: FolderProjectUpdate;
    actor: PageMutationActor;
    idempotencyKey: string;
    request: Record<string, unknown>;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplications?: BoardYjsDocumentApplication[];
  }): Promise<FolderProjectIdentityMutationResult>;
  findByFolderId(folderId: string): Promise<FolderProjectBinding | null>;
  findByPageId(pageId: string): Promise<FolderProjectBinding | null>;
  readPageSnapshot(pageId: string): Promise<Uint8Array | null>;

}

export interface FolderProjectIdentityServiceConfig {
  repository: FolderProjectIdentityRepository;
  withBoardApplication: BoardYjsService["withFolderBoardApplication"];
  createId?: () => string;
  createOperationId?: () => string;
  hydratePage: (pageId: string) => Promise<void>;
  onCommitted?: () => Promise<void>;
  onPageUpdated?: PageUpdatedObserver;
}
