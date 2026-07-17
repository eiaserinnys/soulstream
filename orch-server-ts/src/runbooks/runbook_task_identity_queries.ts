import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type {
  LegacyRunbookBinding,
  TaskPageTitleBinding,
  TaskIdentityBinding,
} from "./runbook_task_identity_contracts.js";

export async function pageTitleRows(
  sql: BoardYjsQuerySql,
  title: string,
): Promise<readonly TaskPageTitleBinding[]> {
  const rows = await sql<readonly PageTitleDbRow[]>`
    SELECT page.id AS page_id, page.title, page.archived,
           page.daily_date::text AS daily_date,
           project_folder.id AS project_folder_id
    FROM pages page
    LEFT JOIN LATERAL (
      SELECT folder.id
      FROM folders folder
      WHERE folder.project_page_id = page.id
      ORDER BY folder.id
      LIMIT 1
    ) project_folder ON TRUE
    WHERE page.title_key = lower(btrim(${title}))
    LIMIT 1
  `;
  return rows.map((row) => ({
    pageId: row.page_id,
    title: row.title,
    archived: row.archived,
    dailyDate: row.daily_date,
    projectFolderId: row.project_folder_id,
  }));
}

export async function bindingRows(
  sql: BoardYjsQuerySql,
  kind: "page" | "runbook",
  id: string,
  lock = false,
): Promise<readonly TaskIdentityBinding[]> {
  const rows = kind === "page"
    ? lock
      ? await sql<readonly BindingDbRow[]>`
          SELECT r.id AS runbook_id, r.task_page_id AS page_id, bi.folder_id,
                 r.board_item_id, r.title, r.archived, bi.x, bi.y,
                 r.version AS runbook_version, p.version AS page_version
          FROM runbooks r
          JOIN pages p ON p.id = r.task_page_id
          JOIN board_items bi ON bi.id = r.board_item_id
          WHERE r.task_page_id = ${id}
          LIMIT 1
          FOR UPDATE OF r, p, bi
        `
      : await sql<readonly BindingDbRow[]>`
        SELECT r.id AS runbook_id, r.task_page_id AS page_id, bi.folder_id,
               r.board_item_id, r.title, r.archived, bi.x, bi.y,
               r.version AS runbook_version, p.version AS page_version
        FROM runbooks r
        JOIN pages p ON p.id = r.task_page_id
        JOIN board_items bi ON bi.id = r.board_item_id
        WHERE r.task_page_id = ${id}
        LIMIT 1
      `
    : lock
      ? await sql<readonly BindingDbRow[]>`
          SELECT r.id AS runbook_id, r.task_page_id AS page_id, bi.folder_id,
                 r.board_item_id, r.title, r.archived, bi.x, bi.y,
                 r.version AS runbook_version, p.version AS page_version
          FROM runbooks r
          JOIN pages p ON p.id = r.task_page_id
          JOIN board_items bi ON bi.id = r.board_item_id
          WHERE r.id = ${id}
          LIMIT 1
          FOR UPDATE OF r, p, bi
        `
      : await sql<readonly BindingDbRow[]>`
        SELECT r.id AS runbook_id, r.task_page_id AS page_id, bi.folder_id,
               r.board_item_id, r.title, r.archived, bi.x, bi.y,
               r.version AS runbook_version, p.version AS page_version
        FROM runbooks r
        JOIN pages p ON p.id = r.task_page_id
        JOIN board_items bi ON bi.id = r.board_item_id
        WHERE r.id = ${id}
        LIMIT 1
      `;
  return rows.map((row) => ({
    runbookId: row.runbook_id,
    pageId: row.page_id,
    folderId: row.folder_id,
    boardItemId: row.board_item_id,
    title: row.title,
    archived: row.archived,
    x: Number(row.x),
    y: Number(row.y),
    runbookVersion: Number(row.runbook_version),
    pageVersion: Number(row.page_version),
  }));
}

export async function legacyBindingRows(
  sql: BoardYjsQuerySql,
  runbookId: string,
): Promise<readonly LegacyRunbookBinding[]> {
  const rows = await sql<readonly LegacyBindingDbRow[]>`
    SELECT r.id AS runbook_id, bi.folder_id, r.board_item_id, r.title,
           r.archived, r.version AS runbook_version, bi.x, bi.y
    FROM runbooks r
    JOIN board_items bi ON bi.id = r.board_item_id
    WHERE r.id = ${runbookId} AND r.task_page_id IS NULL
    LIMIT 1
  `;
  return rows.map((row) => ({
    runbookId: row.runbook_id,
    folderId: row.folder_id,
    boardItemId: row.board_item_id,
    title: row.title,
    archived: row.archived,
    runbookVersion: Number(row.runbook_version),
    x: Number(row.x),
    y: Number(row.y),
  }));
}

interface BindingDbRow extends Record<string, unknown> {
  runbook_id: string;
  page_id: string;
  folder_id: string;
  board_item_id: string;
  title: string;
  archived: boolean;
  x: string | number;
  y: string | number;
  runbook_version: string | number;
  page_version: string | number;
}

interface LegacyBindingDbRow extends Record<string, unknown> {
  runbook_id: string;
  folder_id: string;
  board_item_id: string;
  title: string;
  archived: boolean;
  runbook_version: string | number;
  x: string | number;
  y: string | number;
}

interface PageTitleDbRow extends Record<string, unknown> {
  page_id: string;
  title: string;
  archived: boolean;
  daily_date: string | null;
  project_folder_id: string | null;
}
