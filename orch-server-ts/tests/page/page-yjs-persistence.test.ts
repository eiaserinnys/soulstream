import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createPageYDocSnapshot,
  readPageYDocReplica,
} from "../../src/page/page_yjs_model.js";
import {
  PageYjsSnapshotMissingError,
  createPageYjsPersistence,
  type PageYjsPersistenceRepository,
} from "../../src/page/page_yjs_persistence.js";

function snapshot(): Uint8Array {
  return createPageYDocSnapshot({
    page: {
      id: "page-1",
      title: "Page",
      dailyDate: null,
      mutationVersion: 1,
      archived: false,
      metadata: {},
    },
    blocks: [{
      id: "block-1",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: "Body",
      properties: {},
      collapsed: false,
    }],
  });
}

function editSnapshot(text: string): {
  base: Uint8Array;
  document: Y.Doc;
  snapshot: Uint8Array;
  update: Uint8Array;
} {
  const base = snapshot();
  const baseDocument = new Y.Doc();
  Y.applyUpdate(baseDocument, base);
  const document = new Y.Doc();
  Y.applyUpdate(document, base);
  const block = document.getMap<Y.Map<unknown>>("blocks").get("block-1");
  const body = block?.get("text");
  if (!(body instanceof Y.Text)) throw new Error("editable block text missing");
  body.insert(body.length, text);
  return {
    base,
    document,
    snapshot: Y.encodeStateAsUpdate(document),
    update: Y.encodeStateAsUpdate(document, Y.encodeStateVector(baseDocument)),
  };
}

describe("orch page Yjs persistence", () => {
  it("returns an existing snapshot without consulting SQL replicas", async () => {
    const state = snapshot();
    const repository = {
      getPageYjsSnapshot: vi.fn().mockResolvedValue(state),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await expect(persistence.database.configuration.fetch?.({
      documentName: "page:page-1",
    } as never)).resolves.toBe(state);
    expect(repository.getPageYjsSnapshot).toHaveBeenCalledWith("page:page-1");
  });

  it("fetches the snapshot only and fails explicitly when it is missing", async () => {
    const repository = {
      getPageYjsSnapshot: vi.fn().mockResolvedValue(null),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await expect(persistence.database.configuration.fetch?.({
      documentName: "page:page-1",
    } as never)).rejects.toMatchObject({
      name: "PageYjsSnapshotMissingError",
      code: "PAGE_YJS_SNAPSHOT_MISSING",
      pageId: "page-1",
    } satisfies Partial<PageYjsSnapshotMissingError>);
    expect(repository.getPageYjsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects non-page document names", async () => {
    const repository = {
      getPageYjsSnapshot: vi.fn(),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await expect(persistence.database.configuration.fetch?.({
      documentName: "board-folder:folder-1",
    } as never)).rejects.toThrow("PAGE_YJS_DOCUMENT_NAME_INVALID");
    expect(repository.getPageYjsSnapshot).not.toHaveBeenCalled();
  });

  it("stores one merged incremental update beside the final snapshot", async () => {
    const edited = editSnapshot(" edited");
    const repository = {
      storePageYjsState: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: edited.update,
    } as never);

    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: edited.document,
      state: edited.snapshot,
    } as never);

    expect(repository.storePageYjsState).toHaveBeenCalledWith({
      documentName: "page:page-1",
      snapshot: edited.snapshot,
      update: edited.update,
      replica: expect.objectContaining({
        page: expect.objectContaining({ id: "page-1" }),
        blocks: [expect.objectContaining({ id: "block-1", text: "Body edited" })],
      }),
    });
    expect(edited.update.byteLength).toBeLessThan(edited.snapshot.byteLength);
  });

  it("retries a failed coalesced store with one bounded state payload", async () => {
    const edited = editSnapshot(" retried");
    let failuresRemaining = 2;
    const repository = {
      storePageYjsState: vi.fn().mockImplementation(async () => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("transient persistence failure");
        }
      }),
    } as unknown as PageYjsPersistenceRepository;
    const onRetry = vi.fn();
    const persistence = createPageYjsPersistence(repository, undefined, { onRetry });

    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: edited.update,
    } as never);

    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: edited.document,
      state: edited.snapshot,
    } as never);

    expect(repository.storePageYjsState).toHaveBeenCalledTimes(3);
    expect(repository.storePageYjsState).toHaveBeenLastCalledWith({
      documentName: "page:page-1",
      snapshot: edited.snapshot,
      update: edited.update,
      replica: expect.objectContaining({
        page: expect.objectContaining({ id: "page-1" }),
      }),
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(persistence.getDiagnostics()).toEqual({
      activeStores: 0,
      failedStores: 0,
      pendingUpdateBytes: 0,
      pendingUpdateDocuments: 0,
      retryAttempts: 2,
    });
  });

  it("treats the actual committed transaction origin as a debounced store no-op", async () => {
    const doc = new Y.Doc();
    const state = snapshot();
    Y.applyUpdate(doc, state);
    const repository = {
      storePageYjsState: vi.fn().mockResolvedValue(undefined),
      hasPageOperation: vi.fn().mockResolvedValue(true),
    } as unknown as PageYjsPersistenceRepository;
    const coordinator = { runExclusive: vi.fn() };
    const persistence = createPageYjsPersistence(repository, coordinator);

    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: doc,
      state,
      transactionOrigin: "operation-1",
    } as never);

    expect(repository.storePageYjsState).not.toHaveBeenCalled();
    expect(repository.hasPageOperation).toHaveBeenCalledWith("operation-1");
    expect(coordinator.runExclusive).not.toHaveBeenCalled();
  });

  it("captures snapshot and replica after the operation lookup and pending take", async () => {
    const document = new Y.Doc();
    Y.applyUpdate(document, snapshot());
    const staleState = Y.encodeStateAsUpdate(document);
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupBarrier = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
    const repository = {
      hasPageOperation: vi.fn().mockImplementation(async () => {
        markLookupStarted();
        await lookupBarrier;
        return true;
      }),
      storePageYjsState: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    const storing = persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document,
      state: staleState,
      transactionOrigin: "operation-1",
    } as never);
    await lookupStarted;
    let clientUpdate: Uint8Array | undefined;
    document.once("update", (update: Uint8Array) => { clientUpdate = update; });
    const block = document.getMap<Y.Map<unknown>>("blocks").get("block-1");
    const body = block?.get("text");
    if (!(body instanceof Y.Text)) throw new Error("editable block text missing");
    body.insert(body.length, " C");
    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: clientUpdate!,
    } as never);
    releaseLookup();
    await storing;

    const stored = vi.mocked(repository.storePageYjsState).mock.calls[0]![0];
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, stored.snapshot);
    const snapshotReplica = readPageYDocReplica("page-1", reloaded);
    expect(snapshotReplica.blocks[0]?.text).toBe("Body C");
    expect(stored.replica).toEqual(snapshotReplica);
    expect(Buffer.from(stored.snapshot).equals(
      Buffer.from(Y.encodeStateAsUpdate(document)),
    )).toBe(true);
    expect(stored.update).toEqual(clientUpdate);
  });

  it("keeps an update that arrives after the fresh snapshot for the next store", async () => {
    const edited = editSnapshot(" A");
    let releaseFirstStore!: () => void;
    let markFirstStoreStarted!: () => void;
    const firstStoreBarrier = new Promise<void>((resolve) => { releaseFirstStore = resolve; });
    const firstStoreStarted = new Promise<void>((resolve) => { markFirstStoreStarted = resolve; });
    let calls = 0;
    const repository = {
      storePageYjsState: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          markFirstStoreStarted();
          await firstStoreBarrier;
        }
      }),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);
    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: edited.update,
    } as never);

    const firstStore = persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: edited.document,
      state: edited.snapshot,
    } as never);
    await firstStoreStarted;
    let laterUpdate: Uint8Array | undefined;
    edited.document.once("update", (update: Uint8Array) => { laterUpdate = update; });
    const block = edited.document.getMap<Y.Map<unknown>>("blocks").get("block-1");
    const body = block?.get("text");
    if (!(body instanceof Y.Text)) throw new Error("editable block text missing");
    body.insert(body.length, " D");
    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: laterUpdate!,
    } as never);
    releaseFirstStore();
    await firstStore;

    expect(persistence.getDiagnostics().pendingUpdateDocuments).toBe(1);
    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: edited.document,
      state: edited.snapshot,
    } as never);

    const firstInput = vi.mocked(repository.storePageYjsState).mock.calls[0]![0];
    const secondInput = vi.mocked(repository.storePageYjsState).mock.calls[1]![0];
    expect(firstInput.replica.blocks[0]?.text).toBe("Body A");
    expect(firstInput.update).toEqual(edited.update);
    expect(secondInput.replica.blocks[0]?.text).toBe("Body A D");
    expect(secondInput.update).toEqual(laterUpdate);
    expect(persistence.getDiagnostics().pendingUpdateDocuments).toBe(0);
  });

  it("restores a failed incremental update so fetch can recover the live state", async () => {
    const edited = editSnapshot(" pending");
    const repository = {
      getPageYjsSnapshot: vi.fn().mockResolvedValue(edited.base),
      storePageYjsState: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository, undefined, { maxAttempts: 1 });
    await persistence.updateCollector.onChange?.({
      documentName: "page:page-1",
      transactionOrigin: { source: "browser" },
      update: edited.update,
    } as never);

    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      document: edited.document,
      state: edited.snapshot,
    } as never);

    expect(persistence.getDiagnostics()).toMatchObject({
      failedStores: 1,
      pendingUpdateDocuments: 1,
      pendingUpdateBytes: edited.update.byteLength,
    });
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, await persistence.database.configuration.fetch?.({
      documentName: "page:page-1",
    } as never) as Uint8Array);
    expect(readPageYDocReplica("page-1", recovered).blocks[0]?.text).toBe("Body pending");
  });
});
