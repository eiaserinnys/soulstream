import { describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { CatalogState } from "../shared/types";
import {
  catalogBoardItemsFromYDoc,
  createMarkdownYjsDocument,
  getBoardYjsDocumentName,
  readRemoteBoardSelections,
  seedBoardYDocFromCatalog,
  setBoardAwarenessSelection,
  updateBoardYjsItemPosition,
  updateMarkdownYjsBody,
  updateMarkdownYjsTitle,
} from "./board-yjs-client";

const catalog: CatalogState = {
  folders: [],
  sessions: {},
  boardItems: [{
    id: "session:s1",
    folderId: "f1",
    itemType: "session",
    itemId: "s1",
    x: 0,
    y: 0,
  }],
};

describe("board-yjs-client", () => {
  it("folder id를 Hocuspocus document name으로 변환", () => {
    expect(getBoardYjsDocumentName("f1")).toBe("board-folder:f1");
  });

  it("catalog seed를 Y-doc boardItems map으로 로드하고 position을 즉시 갱신", () => {
    const doc = new Y.Doc();
    seedBoardYDocFromCatalog(doc, "f1", catalog);

    updateBoardYjsItemPosition(doc, "session:s1", 280, 160);

    expect(catalogBoardItemsFromYDoc("f1", doc)[0]).toMatchObject({
      id: "session:s1",
      x: 280,
      y: 160,
    });
  });

  it("frame board item type과 metadata를 Yjs roundtrip으로 보존한다", () => {
    const doc = new Y.Doc();
    seedBoardYDocFromCatalog(doc, "folder-a", {
      folders: [],
      sessions: {},
      boardItems: [{
        id: "frame:launch",
        folderId: "folder-a",
        itemType: "frame",
        itemId: "frame:launch",
        x: 20,
        y: 40,
        metadata: {
          title: "Launch",
          collapsed: true,
          childItemIds: ["session:a"],
          width: 640,
          height: 420,
        },
      }],
    });

    expect(catalogBoardItemsFromYDoc("folder-a", doc)).toEqual([
      expect.objectContaining({
        id: "frame:launch",
        itemType: "frame",
        itemId: "frame:launch",
        x: 20,
        y: 40,
        metadata: expect.objectContaining({
          title: "Launch",
          collapsed: true,
          childItemIds: ["session:a"],
        }),
      }),
    ]);
  });

  it("runbook board item type과 metadata를 Yjs roundtrip으로 보존한다", () => {
    const doc = new Y.Doc();
    seedBoardYDocFromCatalog(doc, "folder-a", {
      folders: [],
      sessions: {},
      boardItems: [{
        id: "runbook:rb-1",
        folderId: "folder-a",
        itemType: "runbook",
        itemId: "rb-1",
        x: 60,
        y: 80,
        metadata: {
          title: "Launch runbook",
        },
      }],
    });

    expect(catalogBoardItemsFromYDoc("folder-a", doc)).toEqual([
      expect.objectContaining({
        id: "runbook:rb-1",
        itemType: "runbook",
        itemId: "rb-1",
        x: 60,
        y: 80,
        metadata: expect.objectContaining({
          title: "Launch runbook",
        }),
      }),
    ]);
  });

  it("Yjs update 적용으로 두 doc 사이 board position이 동기화", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedBoardYDocFromCatalog(a, "f1", catalog);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    updateBoardYjsItemPosition(a, "session:s1", -80, 40);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(catalogBoardItemsFromYDoc("f1", b)[0]).toMatchObject({
      x: -80,
      y: 40,
    });
  });

  it("markdown document는 board item과 Y.Text를 같이 만든다", () => {
    const doc = new Y.Doc();

    const result = createMarkdownYjsDocument(doc, "f1", {
      documentId: "d1",
      title: "Note",
      body: "hello",
      x: 0,
      y: 0,
    });

    expect(result.boardItem).toMatchObject({ id: "markdown:d1", itemType: "markdown" });
    expect(result.document.version).toBe(1);
    expect(result.boardItem.metadata).toMatchObject({ version: 1 });
    expect(doc.getMap<Y.Text>("markdownBodies").get("d1")?.toString()).toBe("hello");
  });

  it("markdown title/body 변경은 Yjs metadata version을 증가시킨다", () => {
    const doc = new Y.Doc();
    createMarkdownYjsDocument(doc, "f1", {
      documentId: "d1",
      title: "Note",
      body: "hello",
      x: 0,
      y: 0,
    });

    updateMarkdownYjsTitle(doc, "d1", "Renamed");
    updateMarkdownYjsBody(doc, "d1", "changed");

    const [item] = catalogBoardItemsFromYDoc("f1", doc);
    expect(item?.metadata).toMatchObject({
      title: "Renamed",
      preview: "changed",
      version: 3,
    });
  });

  it("awareness selection은 remote client만 읽는다", () => {
    const localDoc = new Y.Doc();
    const remoteDoc = new Y.Doc();
    const local = new Awareness(localDoc);
    const remote = new Awareness(remoteDoc);

    setBoardAwarenessSelection(local, "session:s1", "#22c55e");
    applyAwarenessUpdate(
      remote,
      encodeAwarenessUpdate(local, [local.clientID]),
      "test",
    );

    expect(readRemoteBoardSelections(remote)).toEqual([{
      clientId: local.clientID,
      itemId: "session:s1",
      color: "#22c55e",
    }]);
  });
});
