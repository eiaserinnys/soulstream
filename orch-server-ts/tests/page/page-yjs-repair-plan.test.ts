import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { readPageYDocReplica } from "../../src/page/page_yjs_model.js";
import { buildPageYjsSnapshotRepairPlan } from "../../src/page/page_yjs_repair_plan.js";

describe("page Yjs snapshot repair plan", () => {
  it("reconstructs the canonical Y.Doc from SQL page and block projections", () => {
    const plan = buildPageYjsSnapshotRepairPlan({
      page: {
        id: "page-1",
        title: "보존할 페이지",
        dailyDate: "2026-07-17",
        mutationVersion: 4,
        archived: false,
        metadata: { starred: true },
      },
      blocks: [{
        id: "block-1",
        parentId: null,
        positionKey: "V",
        type: "checklist",
        text: "보존할 본문",
        properties: { checked: true },
        collapsed: false,
      }],
    });

    const document = new Y.Doc();
    Y.applyUpdate(document, plan.snapshot);
    expect(readPageYDocReplica("page-1", document)).toMatchObject({
      page: {
        id: "page-1",
        title: "보존할 페이지",
        dailyDate: "2026-07-17",
        mutationVersion: 4,
        metadata: { starred: true },
      },
      blocks: [{
        id: "block-1",
        type: "checklist",
        text: "보존할 본문",
        properties: { checked: true },
      }],
    });
    expect(plan).toMatchObject({
      pageId: "page-1",
      blockCount: 1,
      strategy: "sql_projection_reconstruction",
    });
    expect(plan.snapshot.byteLength).toBeGreaterThan(0);
  });
});
