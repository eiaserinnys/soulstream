import type {
  BoardYjsContainerScope,
  BoardYjsReplica,
  CatalogBoardItemRow,
} from "../board-yjs/board_yjs_types.js";
import type {
  PageMutationActor,
  PageMutationApplication,
} from "../page/page_mutation_core.js";
import type { PageMutationCommitResult } from "../page/page_repository.js";
import type { PageUpdatedObserver } from "../page/page_update_notifications.js";

export interface RunbookTaskIdentityBoardApplication {
  documentName: string;
  scope: BoardYjsContainerScope;
  snapshot: Uint8Array;
  replica: BoardYjsReplica;
}

export interface RunbookTaskIdentityBoardMoveApplication {
  movedBoardItem: CatalogBoardItemRow;
  boardApplications: readonly RunbookTaskIdentityBoardApplication[];
}

export interface RunbookTaskIdentityBoardPort {
  withRunbookBoardApplication<T>(
    input: {
      folderId: string;
      boardItemId: string;
      runbookId: string;
      title: string;
      archived: boolean;
      x: number;
      y: number;
    },
    persist: (application: RunbookTaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T>;
  withRunbookBoardMoveApplication(
    input: {
      boardItem: CatalogBoardItemRow;
      targetScope: BoardYjsContainerScope;
      position?: { x: number; y: number };
    },
    persist: (application: RunbookTaskIdentityBoardMoveApplication) => Promise<void>,
  ): Promise<CatalogBoardItemRow>;
}

export interface TaskIdentityBinding {
  runbookId: string;
  pageId: string;
  folderId: string;
  boardItemId: string;
  title: string;
  archived: boolean;
  x: number;
  y: number;
  runbookVersion: number;
  pageVersion: number;
}

export interface TaskProjectPageBinding {
  pageId: string;
}

export interface TaskPageTitleBinding {
  pageId: string;
  title: string;
  archived: boolean;
  dailyDate: string | null;
  projectFolderId: string | null;
}

export interface TaskMountBinding {
  sourcePageId: string;
  sourceBlockIds: readonly string[];
}

export interface TaskMountPageApplication {
  pageId: string;
  operationId: string;
  application: PageMutationApplication;
}

export interface TaskMountExpectation {
  scope: "all" | "project";
  bindings: readonly TaskMountBinding[];
}

export interface LegacyRunbookBinding {
  runbookId: string;
  folderId: string;
  boardItemId: string;
  title: string;
  archived: boolean;
  runbookVersion: number;
  x: number;
  y: number;
}

export interface LegacyRunbookBackfillResult {
  runbookId: string;
  pageId: string;
  createdPage: boolean;
  operation: Record<string, unknown>;
  pageCommit?: PageMutationCommitResult;
  idempotent?: boolean;
}

export interface RunbookTaskIdentityMutationResult {
  id: string;
  pageId: string;
  runbookId: string;
  projectPageId?: string;
  snapshot: {
    runbook: Record<string, unknown>;
    sections: readonly Record<string, unknown>[];
    items: readonly Record<string, unknown>[];
  };
  operation: Record<string, unknown>;
  pageOperation: Record<string, unknown>;
  pageCommit: PageMutationCommitResult;
  idempotent?: boolean;
}

export interface RunbookTaskIdentityRepository {
  findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RunbookTaskIdentityMutationResult | null>;
  findLegacyBackfillByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LegacyRunbookBackfillResult | null>;
  create(input: {
    id: string;
    pageId: string;
    runbookId: string;
    taskPageId: string;
    boardItemId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: RunbookTaskIdentityBoardApplication;
    expectedProjectPageId: string | null;
    projectPageOperationId?: string;
    projectPageApplication?: PageMutationApplication;
  }): Promise<RunbookTaskIdentityMutationResult>;
  promote(input: {
    id: string;
    pageId: string;
    runbookId: string;
    taskPageId: string;
    boardItemId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: RunbookTaskIdentityBoardApplication;
    expectedProjectPageId?: string | null;
    mountPageApplications?: readonly TaskMountPageApplication[];
    mountExpectation?: TaskMountExpectation;
  }): Promise<RunbookTaskIdentityMutationResult>;
  mutate(input: {
    binding: TaskIdentityBinding;
    title: string;
    archived: boolean;
    expectedRunbookVersion: number;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    operationType: "update_runbook" | "archive_runbook" | "unarchive_runbook";
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: RunbookTaskIdentityBoardApplication;
    mountPageApplications?: readonly TaskMountPageApplication[];
    mountExpectation?: TaskMountExpectation;
  }): Promise<RunbookTaskIdentityMutationResult>;
  move(input: {
    binding: TaskIdentityBinding;
    sourceFolderId: string;
    targetFolderId: string;
    expectedTargetProjectPageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    boardApplications: readonly RunbookTaskIdentityBoardApplication[];
    mountPageApplications: readonly TaskMountPageApplication[];
    mountExpectation: TaskMountExpectation;
  }): Promise<void>;
  findLegacyRunbook(runbookId: string): Promise<LegacyRunbookBinding | null>;
  bindLegacyPage(input: {
    binding: LegacyRunbookBinding;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
  }): Promise<LegacyRunbookBackfillResult>;
  createLegacyPageAndBind(input: {
    binding: LegacyRunbookBinding;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<LegacyRunbookBackfillResult>;
  findByPageId(pageId: string): Promise<TaskIdentityBinding | null>;
  findByRunbookId(runbookId: string): Promise<TaskIdentityBinding | null>;
  findPageByTitle(title: string): Promise<TaskPageTitleBinding | null>;
  findCreateResultByRunbookId(
    runbookId: string,
  ): Promise<RunbookTaskIdentityMutationResult | null>;
  findProjectPageByFolderId(folderId: string): Promise<TaskProjectPageBinding | null>;
  listTaskMounts(
    pageId: string,
    scope: "all" | "project",
  ): Promise<readonly TaskMountBinding[]>;
  readPageSnapshot(pageId: string): Promise<Uint8Array | null>;
}

export interface RunbookTaskIdentityServiceConfig {
  board: RunbookTaskIdentityBoardPort;
  repository: RunbookTaskIdentityRepository;
  createId?: () => string;
  createOperationId?: () => string;
  createBlockId?: () => string;
  hydratePage: (pageId: string) => Promise<void>;
  onPageUpdated?: PageUpdatedObserver;
}
