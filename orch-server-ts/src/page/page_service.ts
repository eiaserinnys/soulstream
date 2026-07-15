import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { Hocuspocus } from "@hocuspocus/server";
import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type WebSocket from "ws";
import * as Y from "yjs";
import type {
  BacklinkDto,
  PageLinkKind,
  PageListDto,
} from "@soulstream/page-model";

import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "../board-yjs/board_yjs_auth.js";
import {
  PageMutationCore,
  type CreatePageMutationInput,
  type PageMutationApplication,
  type PageMutationInput,
} from "./page_mutation_core.js";
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

export interface PageServiceRepository extends PageYjsPersistenceRepository {
  getPageMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PageMutationCommitResult | null>;
  hasPageOperation(operationId: string): Promise<boolean>;
  getPageTimestamps(
    pageId: string,
  ): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date } | null>;
  findPageIdByTitle(title: string): Promise<string | null>;
  findPageIdByDailyDate(date: string): Promise<string | null>;
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
  repository: PageServiceRepository;
  mutationCore?: PageMutationCore;
  createOperationId?: () => string;
  createPageId?: () => string;
  now?: () => Date;
  auth?: BoardYjsAuthConfig;
  logger?: FastifyBaseLogger;
  mutateTaskIdentity?: (
    input: PageMutationInput,
  ) => Promise<PageServiceMutationResult | null>;
  mutateProjectIdentity?: (
    input: PageMutationInput,
  ) => Promise<PageServiceMutationResult | null>;
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

export interface PageServiceBrowserReadResult extends PageServiceReadResult {
  state_vector: string;
}

export interface PageServiceMutationResult extends PageServiceReadResult {
  operation: PageOperationRecord;
  temp_id_mapping: Record<string, string>;
  idempotent?: boolean;
}

export interface PageServiceDailyResult {
  page: PageServicePageDto;
  created: boolean;
  operation?: PageOperationRecord;
}

export class PageYjsService {
  private readonly mutationCore: PageMutationCore;
  private readonly createOperationId: () => string;
  private readonly createPageId: () => string;
  private readonly now: () => Date;
  private readonly mutex = new PageAsyncMutex();
  private readonly dailyMutex = new PageAsyncMutex();
  private readonly hocuspocus: Hocuspocus;
  private readonly persistence: PageYjsPersistence;

  constructor(private readonly config: PageYjsServiceConfig) {
    this.mutationCore = config.mutationCore ?? new PageMutationCore();
    this.createOperationId = config.createOperationId ?? randomUUID;
    this.createPageId = config.createPageId ?? randomUUID;
    this.now = config.now ?? (() => new Date());
    this.persistence = createPageYjsPersistence(config.repository, this.mutex, {
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
    });
    this.hocuspocus = new Hocuspocus({
      name: "soulstream-page-yjs",
      quiet: true,
      debounce: 500,
      maxDebounce: 5_000,
      extensions: [
        ...(config.auth === undefined
          ? []
          : [createPageYjsAuthExtension(config.auth, config.logger)]),
        this.persistence.updateCollector,
        this.persistence.database,
      ],
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
      await this.hydrateCommittedPage(documentName);
      return toMutationResult(application.replica, application.tempIdMapping, committed);
    });
  }

  async mutatePage(input: PageMutationInput): Promise<PageServiceMutationResult> {
    const taskIdentityResult = await this.config.mutateTaskIdentity?.(input);
    if (taskIdentityResult) return taskIdentityResult;
    const projectIdentityResult = await this.config.mutateProjectIdentity?.(input);
    if (projectIdentityResult) return projectIdentityResult;
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
        Y.applyUpdate(live, application.update, operationId);
        const debounceId = `onStoreDocument-${documentName}`;
        if (this.hocuspocus.debouncer.isDebounced(debounceId)) {
          await this.hocuspocus.debouncer.executeNow(debounceId);
        }
        return toMutationResult(application.replica, application.tempIdMapping, committed);
      } finally {
        connectionContext.skipPagePersistence = true;
        await connection.disconnect();
      }
    });
  }

  async transferBlocks(input: PageBlockTransferInput): Promise<PageBlockTransferResult> {
    return await transferPageBlocks({
      repository: this.config.repository,
      mutationCore: this.mutationCore,
      mutex: this.mutex,
      hocuspocus: this.hocuspocus,
      createOperationId: this.createOperationId,
      hydrateCommittedPage: async (documentName) => await this.hydrateCommittedPage(documentName),
      decodeSnapshot: (snapshot) => this.decodeSnapshot(snapshot),
      toMutationResult,
    }, input);
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

  async findPage(title: string): Promise<PageServicePageDto | null> {
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

  async getDailyPage(input: {
    date?: string;
    actor: CreatePageMutationInput["actor"];
  }): Promise<PageServiceDailyResult> {
    const date = input.date ?? kstDate(this.now());
    return await this.dailyMutex.runExclusive(date, async () => {
      const existingId = await this.config.repository.findPageIdByDailyDate(date);
      if (existingId) return { page: (await this.getPage(existingId)).page, created: false };
      const created = await this.createPage({
        page: {
          id: this.createPageId(),
          title: dailyPageTitle(date),
          dailyDate: date,
          metadata: {},
        },
        actor: input.actor,
        idempotencyKey: `get_daily_page:KST:${date}`,
      });
      return { page: created.page, operation: created.operation, created: true };
    });
  }

  handleConnection(socket: WebSocket, request: IncomingMessage, pageId: string): void {
    void this.openConnection(socket, request, pageId);
  }

  assertWebsocketAuthConfigured(): void {
    if (this.config.auth === undefined) {
      throw new Error("Page Yjs websocket authentication is not configured");
    }
  }

  decodeSnapshot(snapshot: Uint8Array): Y.Doc {
    const document = new Y.Doc();
    Y.applyUpdate(document, snapshot);
    return document;
  }

  async close(): Promise<void> {
    await closePageYjsRuntime(this.hocuspocus, this.persistence);
  }

  getPersistenceDiagnostics(): PageYjsServiceDiagnostics {
    return getPageYjsServiceDiagnostics(this.hocuspocus, this.persistence);
  }

  async hydrateCommittedPage(documentName: string): Promise<void> {
    const connection = await this.hocuspocus.openDirectConnection(documentName, {
      pageLockHeld: true,
      source: "page-operation",
      skipPagePersistence: true,
    });
    await connection.disconnect();
  }

  private async openConnection(
    socket: WebSocket,
    request: IncomingMessage,
    pageId: string,
  ): Promise<void> {
    try {
      const documentName = getPageYjsDocumentName(pageId);
      const snapshot = await this.config.repository.getPageYjsSnapshot(documentName);
      if (!snapshot) throw new Error(`page snapshot missing: ${pageId}`);
      readPageYDocReplica(pageId, this.decodeSnapshot(snapshot));
      this.hocuspocus.handleConnection(socket, request, { pageId, documentName });
    } catch (error) {
      this.config.logger?.error(
        { err: error, pageId },
        "Page Yjs websocket rejected invalid document",
      );
      socket.close(1008, "invalid page document");
    }
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

function kstDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dailyPageTitle(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

function createPageYjsAuthExtension(
  auth: BoardYjsAuthConfig,
  logger?: FastifyBaseLogger,
): Extension {
  return {
    extensionName: "soulstream-page-yjs-auth",
    async onAuthenticate(payload: onAuthenticatePayload) {
      const routePageId = (payload.context as { pageId?: unknown } | undefined)?.pageId;
      if (
        typeof routePageId !== "string" ||
        getPageYjsDocumentName(routePageId) !== payload.documentName
      ) {
        throw new Error("Page Yjs route pageId does not match document name");
      }
      const result = await authenticateBoardYjsConnection({
        token: payload.token,
        requestHeaders: payload.requestHeaders,
        config: auth,
      });
      logger?.debug(
        {
          documentName: payload.documentName,
          authSource: result.source,
          subject: result.subject,
        },
        "Page Yjs websocket authenticated",
      );
      return { user: result.subject };
    },
  };
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
