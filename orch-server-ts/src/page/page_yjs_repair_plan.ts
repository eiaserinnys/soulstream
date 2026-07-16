import {
  createPageYDocSnapshot,
  type PageYjsBlockInput,
  type PageYjsPageReplica,
} from "./page_yjs_model.js";

export interface PageYjsSnapshotRepairSource {
  page: PageYjsPageReplica;
  blocks: readonly PageYjsBlockInput[];
}

export interface PageYjsSnapshotRepairPlan {
  pageId: string;
  blockCount: number;
  strategy: "sql_projection_reconstruction";
  snapshot: Uint8Array;
}

export function buildPageYjsSnapshotRepairPlan(
  source: PageYjsSnapshotRepairSource,
): PageYjsSnapshotRepairPlan {
  const snapshot = createPageYDocSnapshot(source);
  return {
    pageId: source.page.id,
    blockCount: source.blocks.length,
    strategy: "sql_projection_reconstruction",
    snapshot,
  };
}
