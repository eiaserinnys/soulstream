import postgres from "postgres";

import { buildPageYjsSnapshotRepairPlan } from "../src/page/page_yjs_repair_plan.js";

interface MissingPageRow {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
}

interface BlockRow {
  id: string;
  parent_id: string | null;
  position_key: string;
  block_type: string;
  text_plain: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });

try {
  const report = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    const pages = await transaction<MissingPageRow[]>`
      SELECT
        p.id, p.title, p.daily_date::text AS daily_date, p.version,
        p.archived, p.metadata
      FROM pages p
      LEFT JOIN board_yjs_documents document
        ON document.name = ('page:' || p.id)
      WHERE document.name IS NULL
      ORDER BY p.id
    `;
    const plans = [];
    for (const page of pages) {
      const blocks = await transaction<BlockRow[]>`
        SELECT
          id, parent_id, position_key, block_type, text_plain,
          properties, collapsed
        FROM blocks
        WHERE page_id = ${page.id}
        ORDER BY position_key, id
      `;
      const plan = buildPageYjsSnapshotRepairPlan({
        page: {
          id: page.id,
          title: page.title,
          dailyDate: page.daily_date,
          mutationVersion: Number(page.version),
          archived: page.archived,
          metadata: page.metadata,
        },
        blocks: blocks.map((block) => ({
          id: block.id,
          parentId: block.parent_id,
          positionKey: block.position_key,
          type: block.block_type,
          text: block.text_plain,
          properties: block.properties,
          collapsed: block.collapsed,
        })),
      });
      plans.push({
        pageId: plan.pageId,
        blockCount: plan.blockCount,
        strategy: plan.strategy,
        snapshotBytes: plan.snapshot.byteLength,
      });
    }
    return plans;
  });
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    writesEnabled: false,
    missingSnapshotCount: report.length,
    recovery: "Reconstruct canonical Y.Doc from SQL pages + blocks projections",
    pages: report,
  }, null, 2)}\n`);
} finally {
  await sql.end();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
