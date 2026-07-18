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

export interface TaskIdentityBoardApplication {
  documentName: string;
  scope: BoardYjsContainerScope;
  snapshot: Uint8Array;
  replica: BoardYjsReplica;
}

export interface TaskIdentityBoardMoveApplication {
  movedBoardItem: CatalogBoardItemRow;
  boardApplications: readonly TaskIdentityBoardApplication[];
}

export interface TaskIdentityBoardPort {
  withTaskBoardApplication<T>(
    input: {
      folderId: string;
      boardItemId: string;
      taskId: string;
      title: string;
      archived: boolean;
      x: number;
      y: number;
    },
    persist: (application: TaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T>;
  withTaskBoardMoveApplication(
    input: {
      boardItem: CatalogBoardItemRow;
      targetScope: BoardYjsContainerScope;
      position?: { x: number; y: number };
    },
    persist: (application: TaskIdentityBoardMoveApplication) => Promise<void>,
  ): Promise<CatalogBoardItemRow>;
}

export interface TaskIdentityBinding {
  taskId: string;
  pageId: string;
  folderId: string;
  boardItemId: string;
  title: string;
  archived: boolean;
  x: number;
  y: number;
  taskVersion: number;
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

export interface LegacyTaskBinding {
  taskId: string;
  folderId: string;
  boardItemId: string;
  title: string;
  archived: boolean;
  taskVersion: number;
  x: number;
  y: number;
}

export interface LegacyTaskBackfillResult {
  taskId: string;
  pageId: string;
  createdPage: boolean;
  operation: Record<string, unknown>;
  pageCommit?: PageMutationCommitResult;
  idempotent?: boolean;
}

export interface TaskIdentityMutationResult {
  id: string;
  pageId: string;
  taskId: string;
  projectPageId?: string;
  snapshot: {
    task: Record<string, unknown>;
    sections: readonly Record<string, unknown>[];
    items: readonly Record<string, unknown>[];
  };
  operation: Record<string, unknown>;
  pageOperation: Record<string, unknown>;
  pageCommit: PageMutationCommitResult;
  idempotent?: boolean;
}

export interface TaskIdentityRepository {
  findMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TaskIdentityMutationResult | null>;
  findLegacyBackfillByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LegacyTaskBackfillResult | null>;
  create(input: {
    id: string;
    pageId: string;
    taskId: string;
    taskPageId: string;
    boardItemId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: TaskIdentityBoardApplication;
    expectedProjectPageId: string | null;
    projectPageOperationId?: string;
    projectPageApplication?: PageMutationApplication;
  }): Promise<TaskIdentityMutationResult>;
  promote(input: {
    id: string;
    pageId: string;
    taskId: string;
    taskPageId: string;
    boardItemId: string;
    folderId: string;
    title: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: TaskIdentityBoardApplication;
    expectedProjectPageId?: string | null;
    mountPageApplications?: readonly TaskMountPageApplication[];
    mountExpectation?: TaskMountExpectation;
  }): Promise<TaskIdentityMutationResult>;
  mutate(input: {
    binding: TaskIdentityBinding;
    title: string;
    archived: boolean;
    expectedTaskVersion: number;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    operationType: "update_task" | "archive_task" | "unarchive_task";
    pageOperationId: string;
    pageApplication: PageMutationApplication;
    boardApplication: TaskIdentityBoardApplication;
    mountPageApplications?: readonly TaskMountPageApplication[];
    mountExpectation?: TaskMountExpectation;
  }): Promise<TaskIdentityMutationResult>;
  move(input: {
    binding: TaskIdentityBinding;
    sourceFolderId: string;
    targetFolderId: string;
    expectedTargetProjectPageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    boardApplications: readonly TaskIdentityBoardApplication[];
    mountPageApplications: readonly TaskMountPageApplication[];
    mountExpectation: TaskMountExpectation;
  }): Promise<void>;
  findLegacyTask(taskId: string): Promise<LegacyTaskBinding | null>;
  bindLegacyPage(input: {
    binding: LegacyTaskBinding;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
  }): Promise<LegacyTaskBackfillResult>;
  createLegacyPageAndBind(input: {
    binding: LegacyTaskBinding;
    pageId: string;
    actor: PageMutationActor;
    idempotencyKey: string;
    operationId: string;
    pageOperationId: string;
    pageApplication: PageMutationApplication;
  }): Promise<LegacyTaskBackfillResult>;
  findByPageId(pageId: string): Promise<TaskIdentityBinding | null>;
  findByTaskId(taskId: string): Promise<TaskIdentityBinding | null>;
  findPageByTitle(title: string): Promise<TaskPageTitleBinding | null>;
  findCreateResultByTaskId(
    taskId: string,
  ): Promise<TaskIdentityMutationResult | null>;
  findProjectPageByFolderId(folderId: string): Promise<TaskProjectPageBinding | null>;
  listTaskMounts(
    pageId: string,
    scope: "all" | "project",
  ): Promise<readonly TaskMountBinding[]>;
  readPageSnapshot(pageId: string): Promise<Uint8Array | null>;
}

export interface TaskIdentityServiceConfig {
  board: TaskIdentityBoardPort;
  repository: TaskIdentityRepository;
  createId?: () => string;
  createOperationId?: () => string;
  createBlockId?: () => string;
  hydratePage: (pageId: string) => Promise<void>;
  onPageUpdated?: PageUpdatedObserver;
}
