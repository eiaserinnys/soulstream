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
}

export interface LegacyProjectFolder {
  folderId: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
}

export interface LegacyFolderBackfillResult {
  folderId: string;
  pageId: string;
  createdPage: boolean;
  operation: Record<string, unknown>;
  pageCommit?: PageMutationCommitResult;
  idempotent?: boolean;
}

export interface FolderProjectIdentityRepository {
  findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<FolderProjectIdentityMutationResult | null>;
  create(input: {
    id: string;
    pageId: string;
    name: string;
    sortOrder: number;
    settings: Record<string, unknown>;
    parentFolderId: string | null;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<FolderProjectIdentityMutationResult>;
  mutate(input: {
    binding: FolderProjectBinding;
    title: string;
    archived: boolean;
    update: FolderProjectUpdate;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<FolderProjectIdentityMutationResult>;
  findByFolderId(folderId: string): Promise<FolderProjectBinding | null>;
  findByPageId(pageId: string): Promise<FolderProjectBinding | null>;
  readPageSnapshot(pageId: string): Promise<Uint8Array | null>;
  listLegacyFolders(): Promise<readonly LegacyProjectFolder[]>;
  bindLegacyPage(input: {
    folder: LegacyProjectFolder;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<LegacyFolderBackfillResult>;
  createLegacyPageAndBind(input: {
    folder: LegacyProjectFolder;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<LegacyFolderBackfillResult>;
}

export interface FolderProjectIdentityServiceConfig {
  repository: FolderProjectIdentityRepository;
  createId?: () => string;
  createOperationId?: () => string;
  hydratePage: (pageId: string) => Promise<void>;
  onCommitted?: () => Promise<void>;
  onPageUpdated?: PageUpdatedObserver;
}
