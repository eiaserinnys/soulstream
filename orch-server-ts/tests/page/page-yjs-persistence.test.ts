import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createPageYDocSnapshot } from "../../src/page/page_yjs_model.js";
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

  it("stores a snapshot and replica through one repository boundary", async () => {
    const state = snapshot();
    const repository = {
      storePageYjsState: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await persistence.database.configuration.store?.({
      documentName: "page:page-1",
      state,
    } as never);

    expect(repository.storePageYjsState).toHaveBeenCalledWith({
      documentName: "page:page-1",
      snapshot: state,
      replica: expect.objectContaining({
        page: expect.objectContaining({ id: "page-1" }),
        blocks: [expect.objectContaining({ id: "block-1", text: "Body" })],
      }),
    });
  });

  it("persists onChange update, snapshot, and replica together", async () => {
    const state = snapshot();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const update = new Uint8Array([1, 2, 3]);
    const repository = {
      storePageYjsState: vi.fn().mockResolvedValue(undefined),
    } as unknown as PageYjsPersistenceRepository;
    const persistence = createPageYjsPersistence(repository);

    await persistence.updateLog.onChange?.({
      documentName: "page:page-1",
      document: doc,
      update,
    } as never);

    expect(repository.storePageYjsState).toHaveBeenCalledWith({
      documentName: "page:page-1",
      snapshot: expect.any(Uint8Array),
      update,
      replica: expect.objectContaining({
        page: expect.objectContaining({ id: "page-1" }),
      }),
    });
  });
});
