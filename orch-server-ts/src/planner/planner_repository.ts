import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import { serializeSessionRow } from "../runtime/live_session_serialization.js";
import type { PlannerReadProvider, PlannerPageInput, PlannerTodayDto, PlannerFolderDetailDto } from "./planner_contract.js";
import { blockDto, pageDto, decodeCursor, decodeStarredFolderCursor, sliceRows } from "./planner_repository_reads.js";
import { loadPlannerFolders } from "./planner_aggregate_query.js";
import { moveStarredFolderOrder } from "./planner_starred_page_order.js";

export class PlannerRepository implements PlannerReadProvider {
  constructor(private readonly resolver: LiveDbSqlResolver) {}
  async moveStarredFolder(input: { pageId: string; beforePageId: string | null }) {
    return moveStarredFolderOrder(this.resolver, input);
  }
  async getStarredFolders(input: PlannerPageInput) {
    const sql = await this.resolver.resolveSql();
    const cursor = decodeStarredFolderCursor(input.cursor);
    const rows = await sql`
      SELECT f.id, p.id AS page_id, o.position::text AS position
      FROM planner_starred_page_order o JOIN pages p ON p.id = o.page_id
      JOIN folders f ON f.project_page_id = p.id
      WHERE NOT f.archived AND NOT p.archived AND p.daily_date IS NULL
        AND f.id NOT IN ('claude', 'llm') AND p.metadata->'starred' = 'true'::jsonb
        AND (${cursor?.position ?? null}::bigint IS NULL OR (o.position, p.id) > (${cursor?.position ?? null}::bigint, ${cursor?.second ?? ""}))
      ORDER BY o.position, p.id LIMIT ${input.limit + 1}
    `;
    const slice = sliceRows(rows, input.limit, "starred-folder", r => [String(r.position), String(r.page_id)], r => String(r.id));
    return { items: await loadPlannerFolders(sql, slice.items), nextCursor: slice.nextCursor };
  }
  async getDailyHistory(input: { before: string; limit: number }) {
    const sql = await this.resolver.resolveSql();
    const rows = await sql`SELECT daily_date::text AS daily_date FROM pages
      WHERE NOT archived AND daily_date IS NOT NULL AND daily_date < ${input.before}::date
      GROUP BY daily_date ORDER BY daily_date DESC LIMIT ${input.limit}`;
    return { dates: rows.map(r => String(r.daily_date)) };
  }
  async getToday(date: string): Promise<PlannerTodayDto | null> {
    const sql = await this.resolver.resolveSql();
    const [page] = await sql`SELECT id, title, daily_date::text, version, archived, metadata, created_at, updated_at
      FROM pages WHERE daily_date = ${date}::date AND NOT archived LIMIT 1`;
    if (!page) return null;
    const blocks = await sql`SELECT b.*, EXISTS(SELECT 1 FROM block_links l WHERE l.source_block_id = b.id AND l.link_kind = 'mount') AS is_mount
      FROM blocks b WHERE b.page_id = ${page.id} ORDER BY b.position_key, b.id`;
    const mounted = await sql`SELECT f.id, MIN(b.position_key) AS position FROM blocks b
      JOIN block_links l ON l.source_block_id = b.id AND l.link_kind = 'mount'
      JOIN folders f ON f.project_page_id = l.target_page_id
      WHERE b.page_id = ${page.id} AND NOT f.archived AND f.id NOT IN ('claude', 'llm')
      GROUP BY f.id ORDER BY position, f.id`;
    const review = await sql`SELECT session_id FROM sessions WHERE review_state = 'needs_review'
      ORDER BY updated_at DESC, session_id DESC LIMIT 50`;
    return { daily: { page: pageDto(page), blocks: blocks.map(blockDto), state_vector: "" },
      folders: await loadPlannerFolders(sql, mounted.map(r => String(r.id))),
      memoBlocks: blocks.filter(r => r.block_type === "paragraph" && !r.is_mount).map(blockDto),
      reviewSessionIds: review.map(r => String(r.session_id)) };
  }
  async getFolder(folderId: string, input: { limit: number }): Promise<PlannerFolderDetailDto | null> {
    const sql = await this.resolver.resolveSql();
    const [row] = await sql`SELECT to_jsonb(f) AS folder, to_jsonb(p) - 'snapshot' - 'state_vector' AS page
      FROM folders f JOIN pages p ON p.id = f.project_page_id WHERE f.id = ${folderId}`;
    if (!row) return null;
    const page = pageDto(row.page as Record<string, unknown>);
    const blocks = await sql`SELECT * FROM blocks WHERE page_id = ${page.id} ORDER BY position_key, id`;
    const sections = await sql`SELECT * FROM checklist_sections WHERE folder_id = ${folderId} ORDER BY position_key, id`;
    const items = await sql`SELECT i.* FROM checklist_items i JOIN checklist_sections s ON s.id = i.section_id
      WHERE s.folder_id = ${folderId} ORDER BY s.position_key, i.position_key, i.id`;
    return { folder: serializeCardRow(row.folder as Record<string, unknown>), page, blocks: blocks.map(blockDto),
      sections: sections.map(serializeCardRow), items: items.map(serializeCardRow),
      subfolders: await this.getSubfolders(folderId, input),
      sessions: await this.getSessions(folderId, input) };
  }
  async getSubfolders(folderId: string, input: PlannerPageInput) {
    const sql = await this.resolver.resolveSql();
    const c = input.cursor ? decodeCursor(input.cursor, "subfolder") : null;
    const rows = await sql`SELECT * FROM folders WHERE parent_folder_id = ${folderId} AND NOT archived
      AND id NOT IN ('claude', 'llm') AND (${c?.first ?? null}::integer IS NULL OR (sort_order, id) > (${c?.first ?? null}::integer, ${c?.second ?? ""}))
      ORDER BY sort_order, id LIMIT ${input.limit + 1}`;
    return sliceRows(rows, input.limit, "subfolder", r => [String(r.sort_order), String(r.id)], serializeCardRow);
  }
  async getSessions(folderId: string, input: PlannerPageInput) {
    const sql = await this.resolver.resolveSql();
    const c = input.cursor ? decodeCursor(input.cursor, "session") : null;
    const rows = await sql`SELECT s.*, to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor
      FROM sessions s WHERE (s.folder_id = ${folderId} OR EXISTS (
        SELECT 1 FROM folders f JOIN blocks b ON b.page_id = f.project_page_id
        WHERE f.id = ${folderId} AND b.block_type = 'session_ref' AND b.properties->>'sessionId' = s.session_id
      )) AND (${c?.first ?? null}::text IS NULL OR (s.updated_at, s.session_id) < (${c?.first ?? null}::timestamptz, ${c?.second ?? ""}))
      ORDER BY s.updated_at DESC, s.session_id DESC LIMIT ${input.limit + 1}`;
    return sliceRows(rows, input.limit, "session", r => [String(r.updated_cursor), String(r.session_id)], r => ({
      ...serializeSessionRow(r), agentSessionId: String(r.session_id), status: String(r.status), eventCount: 0 }));
  }
}
