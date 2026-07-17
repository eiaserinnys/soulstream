import Fastify from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { projectPageLinks } from "../../src/page/page_link_projection.js";
import type {
  CommitPageMutationInput,
  PageMutationCommitResult,
  PageOperationRecord,
} from "../../src/page/page_repository.js";
import {
  createPageYDocSnapshot,
  readPageYDocReplica,
  type PageYjsReplica,
} from "../../src/page/page_yjs_model.js";
import { registerPageYjsRoutes } from "../../src/page/page_yjs_route.js";
import { PageYjsService } from "../../src/page/page_service.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()));
});

describe("Page Yjs rapid-edit persistence", () => {
  it("bounds 3,000 edits and persists one merged incremental update", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock("[[Target]]"));
    const baseSnapshot = repository.snapshots.get("page:page-1")!;
    const { app, service } = createHarness(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const provider = connectProvider(address, "page-1");
      await waitForSync(provider);
      const text = getEditableText(provider.document);

      for (let index = 0; index < 3_000; index += 1) text.insert(text.length, "x");
      await waitFor(() => repository.storeCount > 0, 10_000);
      await waitFor(() => {
        const diagnostics = service.getPersistenceDiagnostics();
        return diagnostics.pendingStores === 0 && diagnostics.pendingUpdateDocuments === 0;
      }, 10_000);

      const finalText = `[[Target]]${"x".repeat(3_000)}`;
      expect(repository.storeCount).toBeLessThanOrEqual(3);
      expect(repository.lastText).toBe(finalText);
      expect(repository.lastLinks).toMatchObject([{
        sourceBlockId: "block-1",
        linkKind: "inline_page",
        targetTitleKey: "target",
      }]);
      const opLogReplica = new Y.Doc();
      Y.applyUpdate(opLogReplica, baseSnapshot);
      for (const update of repository.successfulUpdates) Y.applyUpdate(opLogReplica, update);
      expect(readPageYDocReplica("page-1", opLogReplica).blocks[0]?.text).toBe(finalText);
      const updateOnly = new Y.Doc();
      for (const update of repository.successfulUpdates) Y.applyUpdate(updateOnly, update);
      expect(() => readPageYDocReplica("page-1", updateOnly)).toThrow();

      await provider.destroy();
      await waitFor(() => service.getPersistenceDiagnostics().activeDocuments === 0);
      expect(service.getPersistenceDiagnostics()).toMatchObject({
        activeDocuments: 0,
        activeConnections: 0,
        pendingStores: 0,
        executingStores: 0,
        activeRepositoryStores: 0,
        pendingUpdateBytes: 0,
        pendingUpdateDocuments: 0,
      });
    } finally {
      await app.close();
    }
  }, 20_000);

  it("skips the trailing store for a durable server operation, then stores a client edit", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock("before"));
    const onPageUpdated = vi.fn();
    const { app, service } = createHarness(repository, {
      createOperationId: () => "operation-1",
      onPageUpdated,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const mutation = await service.mutatePage({
        pageId: "page-1",
        expectedVersion: 1,
        actor: { actorKind: "agent", actorSessionId: "agent-session" },
        idempotencyKey: "update_block_text:agent-session:operation-1",
        command: { type: "update_block_text", blockId: "block-1", text: "server" },
      });
      expect(mutation.blocks[0]?.text).toBe("server");
      await waitFor(() => repository.hasPageOperationCalls > 0);
      expect(repository.storeCount).toBe(0);
      expect(onPageUpdated).toHaveBeenCalledTimes(1);
      expect(onPageUpdated).toHaveBeenLastCalledWith({ pageId: "page-1", version: 2 });

      const provider = connectProvider(address, "page-1");
      await waitForSync(provider);
      getEditableText(provider.document).insert("server".length, "-client");
      await waitFor(() => repository.storeCount === 1);
      expect(repository.lastText).toBe("server-client");
      expect(repository.successfulUpdates).toHaveLength(1);
      expect(onPageUpdated).toHaveBeenCalledTimes(2);
      expect(onPageUpdated).toHaveBeenLastCalledWith({ pageId: "page-1", version: 2 });
    } finally {
      await app.close();
    }
  }, 20_000);

  it("isolates coalescing and final state across two rapidly edited pages", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock("one:"));
    repository.seed("page-2", editableBlock("two:"));
    const { app, service } = createHarness(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const first = connectProvider(address, "page-1");
      const second = connectProvider(address, "page-2");
      await Promise.all([waitForSync(first), waitForSync(second)]);
      const firstText = getEditableText(first.document);
      const secondText = getEditableText(second.document);
      for (let index = 0; index < 1_000; index += 1) {
        firstText.insert(firstText.length, "a");
        secondText.insert(secondText.length, "b");
      }
      await waitFor(() => {
        const diagnostics = service.getPersistenceDiagnostics();
        return repository.storeCount >= 2 && diagnostics.pendingStores === 0 &&
          diagnostics.pendingUpdateDocuments === 0;
      }, 10_000);

      expect(repository.storeCountsByDocument.get("page:page-1")).toBeLessThanOrEqual(3);
      expect(repository.storeCountsByDocument.get("page:page-2")).toBeLessThanOrEqual(3);
      expect(repository.textByDocument.get("page:page-1")).toBe(`one:${"a".repeat(1_000)}`);
      expect(repository.textByDocument.get("page:page-2")).toBe(`two:${"b".repeat(1_000)}`);

      await Promise.all([first.destroy(), second.destroy()]);
      await waitFor(() => service.getPersistenceDiagnostics().activeDocuments === 0);
    } finally {
      await app.close();
    }
  }, 20_000);

  it("retries transient persistence failure without growing a memory queue", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock(""));
    const baseSnapshot = repository.snapshots.get("page:page-1")!;
    repository.failuresRemaining = 2;
    const { app, service } = createHarness(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const provider = connectProvider(address, "page-1");
      await waitForSync(provider);
      const text = getEditableText(provider.document);
      for (let index = 0; index < 1_000; index += 1) text.insert(text.length, "r");
      const finalText = "r".repeat(1_000);
      await waitFor(() => {
        const diagnostics = service.getPersistenceDiagnostics();
        return repository.lastText === finalText &&
          diagnostics.pendingStores === 0 &&
          diagnostics.executingStores === 0 &&
          diagnostics.activeRepositoryStores === 0 &&
          diagnostics.pendingUpdateDocuments === 0;
      }, 10_000);

      expect(repository.storeCount).toBeLessThanOrEqual(3);
      expect(repository.storeAttempts).toBe(2 + repository.storeCount);
      expect(repository.successfulUpdates).toHaveLength(repository.storeCount);
      expect(repository.attemptedUpdates).toHaveLength(repository.storeAttempts);
      expect(repository.attemptedUpdates.slice(0, 3).every((update) =>
        Buffer.from(update).equals(Buffer.from(repository.attemptedUpdates[0]!))
      )).toBe(true);
      expect(repository.lastText).toBe(finalText);
      const opLogReplica = new Y.Doc();
      Y.applyUpdate(opLogReplica, baseSnapshot);
      for (const update of repository.successfulUpdates) Y.applyUpdate(opLogReplica, update);
      expect(readPageYDocReplica("page-1", opLogReplica).blocks[0]?.text).toBe(finalText);
      expect(service.getPersistenceDiagnostics()).toMatchObject({
        activeRepositoryStores: 0,
        failedStores: 0,
        pendingUpdateBytes: 0,
        pendingUpdateDocuments: 0,
        retryAttempts: 2,
      });
    } finally {
      await app.close();
    }
  }, 20_000);

  it("atomically remerges updates that arrive while a bounded store fails", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock(""));
    repository.failuresRemaining = 3;
    repository.pauseNextAttempt();
    const { app, service } = createHarness(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const provider = connectProvider(address, "page-1");
      await waitForSync(provider);
      const text = getEditableText(provider.document);
      text.insert(0, "first");
      await waitFor(() => repository.storeAttempts === 1);
      text.insert(text.length, "-during-failure");
      repository.releasePausedAttempt();

      await waitFor(() => service.getPersistenceDiagnostics().failedStores === 1);
      await waitFor(() => repository.storeCount === 1);
      expect(repository.storeAttempts).toBe(4);
      expect(repository.successfulUpdates).toHaveLength(1);
      expect(repository.lastText).toBe("first-during-failure");
      expect(service.getPersistenceDiagnostics()).toMatchObject({
        activeRepositoryStores: 0,
        failedStores: 1,
        pendingUpdateBytes: 0,
        pendingUpdateDocuments: 0,
        retryAttempts: 2,
      });
    } finally {
      await app.close();
    }
  }, 20_000);

  it("flushes trailing state and clears lifecycle work on server close", async () => {
    const repository = new InstrumentedPageRepository();
    repository.seed("page-1", editableBlock("before"));
    const { app, service } = createHarness(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    let closed = false;
    try {
      const provider = connectProvider(address, "page-1");
      await waitForSync(provider);
      const text = getEditableText(provider.document);
      text.insert(text.length, "-close");

      await app.close();
      closed = true;

      expect(repository.storeCount).toBe(1);
      expect(repository.lastText).toBe("before-close");
      expect(service.getPersistenceDiagnostics()).toEqual({
        activeDocuments: 0,
        activeConnections: 0,
        pendingStores: 0,
        executingStores: 0,
        activeRepositoryStores: 0,
        failedStores: 0,
        pendingUpdateBytes: 0,
        pendingUpdateDocuments: 0,
        retryAttempts: 0,
      });
      await provider.destroy();
    } finally {
      if (!closed) await app.close();
    }
  }, 20_000);
});

function createHarness(
  repository: InstrumentedPageRepository,
  options: {
    createOperationId?: () => string;
    onPageUpdated?: (event: { pageId: string; version: number }) => void;
  } = {},
) {
  const app = Fastify({ logger: false });
  const service = new PageYjsService({
    repository,
    auth: productionAuth(),
    logger: app.log,
    ...options,
  });
  registerPageYjsRoutes(app, {
    createService: () => service,
    authBearerToken: "service-token",
  });
  return { app, service };
}

function connectProvider(address: string, pageId: string): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: `${address.replace("http", "ws")}/yjs/page/${pageId}`,
    name: `page:${pageId}`,
    document: new Y.Doc(),
    token: "service-token",
    WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });
  providers.push(provider);
  return provider;
}

function waitForSync(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider sync timed out")), 10_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function productionAuth() {
  return {
    authBearerToken: "service-token",
    environment: "production",
    dashboardAuthEnabled: false,
    verifyDashboardToken: async () => null,
  };
}

function editableBlock(text: string) {
  return {
    id: "block-1",
    parentId: null,
    positionKey: "a",
    type: "paragraph",
    text,
    properties: {},
    collapsed: false,
  };
}

function getEditableText(document: Y.Doc): Y.Text {
  const block = document.getMap<Y.Map<unknown>>("blocks").get("block-1");
  const text = block?.get("text");
  if (!(text instanceof Y.Text)) throw new Error("editable block text missing");
  return text;
}

class InstrumentedPageRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  readonly storeCountsByDocument = new Map<string, number>();
  readonly textByDocument = new Map<string, string>();
  readonly operations = new Set<string>();
  readonly attemptedUpdates: Uint8Array[] = [];
  readonly successfulUpdates: Uint8Array[] = [];
  storeCount = 0;
  storeAttempts = 0;
  hasPageOperationCalls = 0;
  failuresRemaining = 0;
  lastText: string | null = null;
  lastSnapshot: Uint8Array | null = null;
  lastUpdate: Uint8Array | null = null;
  lastLinks: ReturnType<typeof projectPageLinks> = [];
  private pausedAttempt: Promise<void> | null = null;
  private releaseAttempt: (() => void) | null = null;

  seed(pageId: string, block: ReturnType<typeof editableBlock>): void {
    this.snapshots.set(`page:${pageId}`, createPageYDocSnapshot({
      page: {
        id: pageId,
        title: "Page",
        dailyDate: null,
        mutationVersion: 1,
        archived: false,
        metadata: {},
      },
      blocks: [block],
    }));
  }

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async hasPageProjection(pageId: string): Promise<boolean> {
    return this.snapshots.has(`page:${pageId}`);
  }

  async storePageYjsState(input: {
    documentName: string;
    snapshot: Uint8Array;
    update?: Uint8Array;
    replica: PageYjsReplica;
  }): Promise<void> {
    this.storeAttempts += 1;
    if (input.update) this.attemptedUpdates.push(input.update);
    if (this.pausedAttempt) {
      const paused = this.pausedAttempt;
      this.pausedAttempt = null;
      await paused;
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("transient memory repository failure");
    }
    this.snapshots.set(input.documentName, input.snapshot);
    this.storeCount += 1;
    this.storeCountsByDocument.set(
      input.documentName,
      (this.storeCountsByDocument.get(input.documentName) ?? 0) + 1,
    );
    this.lastText = input.replica.blocks.find((block) => block.id === "block-1")?.text ?? null;
    if (this.lastText !== null) this.textByDocument.set(input.documentName, this.lastText);
    this.lastSnapshot = input.snapshot;
    this.lastUpdate = input.update ?? null;
    if (input.update) this.successfulUpdates.push(input.update);
    this.lastLinks = projectPageLinks(input.replica);
  }

  pauseNextAttempt(): void {
    this.pausedAttempt = new Promise((resolve) => { this.releaseAttempt = resolve; });
  }

  releasePausedAttempt(): void {
    this.releaseAttempt?.();
    this.releaseAttempt = null;
  }

  async hasPageOperation(operationId: string): Promise<boolean> {
    this.hasPageOperationCalls += 1;
    return this.operations.has(operationId);
  }
  async getPageMutationByIdempotencyKey(): Promise<null> { return null; }
  async getPageTimestamps() { return { pageCreatedAt: new Date(0), pageUpdatedAt: new Date(0) }; }
  async findPageIdByTitle(): Promise<null> { return null; }
  async findPageIdByDailyDate(): Promise<null> { return null; }
  async listPages() { return { items: [], next_cursor: null }; }
  async getPageBacklinks() { return { items: [], next_cursor: null }; }
  async commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult> {
    this.snapshots.set(input.documentName, input.application.snapshot);
    this.operations.add(input.operationId);
    const operation: PageOperationRecord = {
      id: input.operationId,
      page_id: input.application.replica.page.id,
      target_block_id: input.application.targetBlockId,
      operation_type: input.application.operationType,
      actor_kind: input.application.actor.actorKind,
      actor_session_id: input.application.actor.actorSessionId ?? null,
      actor_event_id: null,
      actor_user_id: input.application.actor.actorUserId ?? null,
      idempotency_key: input.application.idempotencyKey,
      expected_version: input.application.expectedVersion,
      result_version: input.application.resultVersion,
      payload_json: input.application.payload,
      reason: input.application.reason,
      created_at: new Date(0),
    };
    return {
      operation,
      pageCreatedAt: new Date(0),
      pageUpdatedAt: new Date(0),
      idempotent: false,
    };
  }
}
