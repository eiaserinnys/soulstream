import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import type WebSocket from "ws";
import * as Y from "yjs";

import {
  PageMutationCore,
  type CreatePageMutationInput,
  type PageMutationApplication,
  type PageMutationInput,
} from "./page_mutation_core.js";
import type {
  CommitPageMutationInput,
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
  type PageYjsPersistenceRepository,
} from "./page_yjs_persistence.js";

export interface PageServiceRepository extends PageYjsPersistenceRepository {
  getPageMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PageMutationCommitResult | null>;
  hasPageOperation(operationId: string): Promise<boolean>;
  getPageTimestamps(
    pageId: string,
  ): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date } | null>;
  commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult>;
}

export interface PageYjsServiceConfig {
  repository: PageServiceRepository;
  mutationCore?: PageMutationCore;
  createOperationId?: () => string;
}

export interface PageServicePageDto {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PageServiceBlockDto {
  id: string;
  page_id: string;
  parent_id: string | null;
  position_key: string;
  block_type: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PageServiceReadResult {
  page: PageServicePageDto;
  blocks: PageServiceBlockDto[];
}

export interface PageServiceMutationResult extends PageServiceReadResult {
  operation: PageOperationRecord;
  temp_id_mapping: Record<string, string>;
  idempotent?: boolean;
}

export class PageYjsService {
  private readonly mutationCore: PageMutationCore;
  private readonly createOperationId: () => string;
  private readonly mutex = new PageAsyncMutex();
  private readonly hocuspocus: Hocuspocus;

  constructor(private readonly config: PageYjsServiceConfig) {
    this.mutationCore = config.mutationCore ?? new PageMutationCore();
    this.createOperationId = config.createOperationId ?? randomUUID;
    const persistence = createPageYjsPersistence(config.repository, this.mutex);
    this.hocuspocus = new Hocuspocus({
      name: "soulstream-page-yjs",
      quiet: true,
      debounce: 500,
      maxDebounce: 5_000,
      extensions: [persistence.updateLog, persistence.database],
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
      await this.hydrateCommittedPage(documentName, operationId);
      return toMutationResult(application.replica, application.tempIdMapping, committed);
    });
  }

  async mutatePage(input: PageMutationInput): Promise<PageServiceMutationResult> {
    return await this.mutex.runExclusive(input.pageId, async () => {
      const idempotent = await this.resolveIdempotent(input.idempotencyKey);
      if (idempotent) return idempotent;
      const documentName = getPageYjsDocumentName(input.pageId);
      const operationId = this.createOperationId();
      const connection = await this.hocuspocus.openDirectConnection(documentName, {
        source: "page-operation",
        pageOperationId: operationId,
      });
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
        Y.applyUpdate(live, application.update, operationId);
        return toMutationResult(application.replica, application.tempIdMapping, committed);
      } finally {
        await connection.disconnect();
      }
    });
  }

  async getPage(pageId: string): Promise<PageServiceReadResult> {
    return await this.mutex.runExclusive(pageId, async () => {
      const documentName = getPageYjsDocumentName(pageId);
      const connection = await this.hocuspocus.openDirectConnection(documentName, {
        source: "page-read",
        skipPagePersistence: true,
      });
      try {
        const document = connection.document as unknown as Y.Doc | null;
        if (!document) throw new Error(`page Y.Doc direct connection closed: ${pageId}`);
        const replica = readPageYDocReplica(pageId, document);
        const times = await this.config.repository.getPageTimestamps(replica.page.id);
        if (!times) throw new Error(`page not found: ${replica.page.id}`);
        return toReadResult(replica, times.pageCreatedAt, times.pageUpdatedAt);
      } finally {
        await connection.disconnect();
      }
    });
  }

  handleConnection(socket: WebSocket, request: IncomingMessage, pageId: string): void {
    this.hocuspocus.handleConnection(socket, request, {
      pageId,
      documentName: getPageYjsDocumentName(pageId),
    });
  }

  decodeSnapshot(snapshot: Uint8Array): Y.Doc {
    const document = new Y.Doc();
    Y.applyUpdate(document, snapshot);
    return document;
  }

  async close(): Promise<void> {
    await this.hocuspocus.hooks("onDestroy", { instance: this.hocuspocus });
    this.hocuspocus.closeConnections();
  }

  private async hydrateCommittedPage(documentName: string, operationId: string): Promise<void> {
    const connection = await this.hocuspocus.openDirectConnection(documentName, {
      source: "page-operation",
      pageOperationId: operationId,
    });
    await connection.disconnect();
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

class PageAsyncMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(pageId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(pageId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.tails.set(pageId, queued);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(pageId) === queued) this.tails.delete(pageId);
    }
  }
}

function toMutationResult(
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
      daily_date: replica.page.dailyDate,
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
