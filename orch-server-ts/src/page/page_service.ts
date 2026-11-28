// 500줄 예외: 페이지 문서와 연결의 수명주기를 한 서비스에서 소유한다.
import { randomUUID } from "node:crypto";
import type { HandoverGate } from "../runtime/handover_gate.js";

import { Hocuspocus } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";
import type {
  BacklinkDto,
  PageDto,
  PageLinkKind,
  PageListDto,
} from "@soulstream/page-model";

import { pageStaleUnloadGuard } from "./page_stale_unload_guard.js";
import { PageMutationCore, type CreatePageMutationInput, type PageMutationInput } from "./page_mutation_core.js";
import type {
  CommitPageMutationInput,
  CommitPageMutationsInput,
  PageMutationCommitResult,
  PageOperationRecord,
} from "./page_repository.js";
import {
  getPageYjsDocumentName,
  readPageYDocReplica,
  type PageYjsReplica,
} from "./page_yjs_model.js";
import {
  createPageYjsPersistence,
  type PageYjsPersistence,
  type PageYjsPersistenceRepository,
} from "./page_yjs_persistence.js";
import type { PageBacklinkPage } from "./page_repository_reads.js";
import type { PlannerBlockDto } from "../planner/planner_contract.js";
import {
  closePageYjsRuntime,
  getPageYjsServiceDiagnostics,
  type PageYjsServiceDiagnostics,
} from "./page_service_lifecycle.js";
import {
  transferPageBlocks,
  type PageBlockTransferInput,
  type PageBlockTransferResult,
} from "./page_block_transfer_service.js";
import { PageAsyncMutex } from "./page_async_mutex.js";
import {
  notifyPageUpdates,
  type PageUpdatedObserver,
} from "./page_update_notifications.js";
import { syncCommittedPageSnapshot } from "./page_committed_snapshot_sync.js";

export interface PageServiceRepository extends PageYjsPersistenceRepository {
  getPageMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PageMutationCommitResult | null>;
  hasPageOperation(operationId: string): Promise<boolean>;
  getPageTimestamps(
    pageId: string,
  ): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date } | null>;
  findPageIdByTitle(title: string): Promise<string | null>;
  listPages(input: {
    starred?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<PageListDto>;
  getPageBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    includeSelf?: boolean;
    limit: number;
  }): Promise<PageBacklinkPage>;
  commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult>;
  commitPageMutations?(input: CommitPageMutationsInput): Promise<PageMutationCommitResult[]>;
}

export interface PageYjsServiceConfig {
  documentGate?: HandoverGate;
  storeDebounceMs?: number;
  storeMaxDebounceMs?: number;
  repository: PageServiceRepository;
  mutationCore?: PageMutationCore;
  createOperationId?: () => string;
  logger?: FastifyBaseLogger;
  onPageUpdated?: PageUpdatedObserver;
  mutateFolderIdentity?: (
    input: PageMutationInput,
  ) => Promise<PageServiceMutationResult | null>;
}

export interface PageServiceReadResult {
  page: PageDto;
  blocks: PlannerBlockDto[];
}

export interface PageServiceBrowserReadResult extends PageServiceReadResult {
  state_vector: string;
}

export interface PageServiceMutationResult extends PageServiceReadResult {
  operation: PageOperationRecord;
  temp_id_mapping: Record<string, string>;
  idempotent?: boolean;
}

export class PageYjsService {
  private closePromise: Promise<void> | undefined;
  private readonly mutationCore: PageMutationCore;
  private readonly createOperationId: () => string;
  private readonly mutex = new PageAsyncMutex();
  private readonly hocuspocus: Hocuspocus;
  private readonly persistence: PageYjsPersistence;

  constructor(private readonly config: PageYjsServiceConfig) {
    this.mutationCore = config.mutationCore ?? new PageMutationCore();
    this.createOperationId = config.createOperationId ?? randomUUID;
    this.persistence = createPageYjsPersistence(config.repository, this.mutex, {
      withDocumentAccess: config.documentGate ? action => config.documentGate!.run(action) : undefined,
      onFailure: ({ documentName, attempts, error }) => {
        config.logger?.error(
          { err: error, documentName, attempts },
          "Page Yjs persistence exhausted bounded retries",
        );
      },
      onRetry: ({ documentName, attempt, error }) => {
        config.logger?.warn(
          { err: error, documentName, attempt },
          "Page Yjs persistence retrying after failure",
        );
      },
      onStored: ({ pageId, version }) => {
        notifyPageUpdates(
          [{ page: { id: pageId, version } }],
          config.onPageUpdated,
          config.logger,
        );
      },
    });
    this.hocuspocus = new Hocuspocus({
      name: "soulstream-page-yjs",
      quiet: true,
      debounce: config.storeDebounceMs ?? 500,
      maxDebounce: config.storeMaxDebounceMs ?? 5_000,
      extensions: [this.persistence.updateCollector, this.persistence.database, pageStaleUnloadGuard],
    });
  }

  async createPage(input: CreatePageMutationInput): Promise<PageServiceMutationResult> {
    return await this.mutex.runExclusive(input.page.id, async () => {
      const idempotent = await this.resolveIdempotent(input.idempotencyKey);
      if (idempotent) return idempotent;
      const documentName = getPageYjsDocumentName(input.page.id);
      if (await this.config.repository.getPageYjsSnapshot(documentName)) {
        throw new Error(`page already exists: ${input.page.id}`);
      }
      const application = this.mutationCore.createPage(input);
      const operationId = this.createOperationId();
      const committed = await this.config.repository.commitPageMutation({
        documentName,
        application,
        operationId,
      });
      if (committed.idempotent) return await this.resultFromCommit(committed);
      const result = toMutationResult(application.replica, application.tempIdMapping, committed);
      notifyPageUpdates([result], this.config.onPageUpdated, this.config.logger);
      await this.syncCommittedPage(documentName, true);
      return result;
    });
  }

  async mutatePage(input: PageMutationInput): Promise<PageServiceMutationResult> {
    const folderIdentityResult = await this.config.mutateFolderIdentity?.(input);
    if (folderIdentityResult) {
      notifyPageUpdates([folderIdentityResult], this.config.onPageUpdated, this.config.logger);
      return folderIdentityResult;
    }
    return await this.mutex.runExclusive(input.pageId, async () => {
      const idempotent = await this.resolveIdempotent(input.idempotencyKey);
      if (idempotent) return idempotent;
      const documentName = getPageYjsDocumentName(input.pageId);
      const operationId = this.createOperationId();
      const connectionContext = {
        pageLockHeld: true,
        source: "page-operation",
        skipPagePersistence: false,
      };
      const connection = await this.hocuspocus.openDirectConnection(
        documentName,
        connectionContext,
      );
      try {
        const live = connection.document as unknown as Y.Doc | null;
        if (!live) throw new Error(`page Y.Doc direct connection closed: ${input.pageId}`);
        const application = this.mutationCore.mutate(live, input);
        const committed = await this.config.repository.commitPageMutation({
          documentName,
          application,
          operationId,
        });
        if (committed.idempotent) return await this.resultFromCommit(committed);
        const result = toMutationResult(application.replica, application.tempIdMapping, committed);
        notifyPageUpdates([result], this.config.onPageUpdated, this.config.logger);
        Y.applyUpdate(live, application.update, operationId);
        const debounceId = `onStoreDocument-${documentName}`;
        if (this.hocuspocus.debouncer.isDebounced(debounceId)) {
          await this.hocuspocus.debouncer.executeNow(debounceId);
        }
        return result;
      } finally {
        connectionContext.skipPagePersistence = true;
        await connection.disconnect();
      }
    });
  }

  async transferBlocks(input: PageBlockTransferInput): Promise<PageBlockTransferResult> {
    const result = await transferPageBlocks({
      repository: this.config.repository,
      mutationCore: this.mutationCore,
      mutex: this.mutex,
      hocuspocus: this.hocuspocus,
      createOperationId: this.createOperationId,
      hydrateCommittedPage: async (documentName) => await this.syncCommittedPage(documentName, true),
      decodeSnapshot: (snapshot) => this.decodeSnapshot(snapshot),
      toMutationResult,
    }, input);
    notifyPageUpdates(
      [result.source, result.target],
      this.config.onPageUpdated,
      this.config.logger,
    );
    return result;
  }

  async getPage(pageId: string): Promise<PageServiceReadResult> {
    const { state_vector: _stateVector, ...result } = await this.getBrowserPage(pageId);
    return result;
  }

  async getBrowserPage(pageId: string): Promise<PageServiceBrowserReadResult> {
    return await this.mutex.runExclusive(pageId, async () => {
      const documentName = getPageYjsDocumentName(pageId);
      const connection = await this.hocuspocus.openDirectConnection(documentName, {
        pageLockHeld: true,
        source: "page-read",
        skipPagePersistence: true,
      });
      try {
        const document = connection.document as unknown as Y.Doc | null;
        if (!document) throw new Error(`page Y.Doc direct connection closed: ${pageId}`);
        const replica = readPageYDocReplica(pageId, document);
        const times = await this.config.repository.getPageTimestamps(replica.page.id);
        if (!times) throw new Error(`page not found: ${replica.page.id}`);
        return {
          ...toReadResult(replica, times.pageCreatedAt, times.pageUpdatedAt),
          state_vector: Buffer.from(Y.encodeStateVector(document)).toString("base64"),
        };
      } finally {
        await connection.disconnect();
      }
    });
  }

  async listPages(input: {
    starred?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<PageListDto> {
    return await this.config.repository.listPages(input);
  }

  async findPage(title: string): Promise<PageDto | null> {
    const pageId = await this.config.repository.findPageIdByTitle(title);
    return pageId ? (await this.getPage(pageId)).page : null;
  }

  async getBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    includeSelf?: boolean;
    limit: number;
  }): Promise<{ items: BacklinkDto[]; next_cursor: string | null }> {
    return await this.config.repository.getPageBacklinks(input);
  }

  decodeSnapshot(snapshot: Uint8Array): Y.Doc {
    const document = new Y.Doc();
    Y.applyUpdate(document, snapshot);
    return document;
  }

  async close(): Promise<void> {
    this.closePromise ??= closePageYjsRuntime(this.hocuspocus, this.persistence);
    await this.closePromise;
  }

  async closeForHandover(): Promise<void> {
    await this.config.documentGate?.close();
    await this.close();
  }

  getPersistenceDiagnostics(): PageYjsServiceDiagnostics {
    return getPageYjsServiceDiagnostics(this.hocuspocus, this.persistence);
  }

  async hydrateCommittedPage(documentName: string): Promise<void> {
    await this.syncCommittedPage(documentName, false);
  }

  private async syncCommittedPage(documentName: string, pageLockHeld: boolean): Promise<void> {
    await syncCommittedPageSnapshot({
      documentName,
      repository: this.config.repository,
      coordinator: this.mutex,
      hocuspocus: this.hocuspocus,
      pageLockHeld,
    });
  }

  private async resolveIdempotent(
    idempotencyKey: string,
  ): Promise<PageServiceMutationResult | null> {
    const committed = await this.config.repository.getPageMutationByIdempotencyKey(idempotencyKey);
    return committed ? await this.resultFromCommit(committed) : null;
  }

  private async resultFromCommit(
    committed: PageMutationCommitResult,
  ): Promise<PageServiceMutationResult> {
    const snapshot = await this.config.repository.getPageYjsSnapshot(
      getPageYjsDocumentName(committed.operation.page_id),
    );
    if (!snapshot) throw new Error(`page snapshot missing: ${committed.operation.page_id}`);
    const replica = readPageYDocReplica(
      committed.operation.page_id,
      this.decodeSnapshot(snapshot),
    );
    return {
      ...toMutationResult(replica, {}, committed),
      idempotent: true,
    };
  }

}

export function toMutationResult(
  replica: PageYjsReplica,
  mapping: Record<string, string>,
  committed: PageMutationCommitResult,
): PageServiceMutationResult {
  return {
    ...toReadResult(replica, committed.pageCreatedAt, committed.pageUpdatedAt),
    operation: committed.operation,
    temp_id_mapping: mapping,
    ...(committed.idempotent ? { idempotent: true } : {}),
  };
}
function toReadResult(
  replica: PageYjsReplica,
  createdAt: Date,
  updatedAt: Date,
): PageServiceReadResult {
  return {
    page: {
      id: replica.page.id,
      title: replica.page.title,
      daily_date: null,
      version: replica.page.mutationVersion,
      archived: replica.page.archived,
      metadata: replica.page.metadata,
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
    },
    blocks: replica.blocks.map((block) => ({
      id: block.id,
      page_id: replica.page.id,
      parent_id: block.parentId,
      position_key: block.positionKey,
      block_type: block.type,
      text: block.text,
      properties: block.properties,
      collapsed: block.collapsed,
    })),
  };
}
