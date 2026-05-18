/**
 * session_query 도구 — Python `mcp_session_query.py` 정합 (키 호환).
 *
 * 모든 도구는 `SessionDB` 신규 메서드(`listSessionsSummary`, `readEvents` 등)에만 의존.
 * dashboard·MCP 양쪽 진입점이 같은 메서드를 호출하므로 정책 정본 단일 (design-principles §3).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const DEFAULT_DOWNLOAD_DIR = "/tmp/soulstream_sessions";
const TOOL_TRUNCATE_DEFAULT = 500;
const SEARCH_PREVIEW_RADIUS = 100;

export function registerSessionQueryTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_sessions",
    {
      description:
        "세션 목록을 페이지네이션하여 조회한다. 경량 필드만 반환 (Python list_sessions 정합).",
      inputSchema: {
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
        folder_id: z.string().optional(),
        folder_name: z.string().optional(),
        node_id: z.string().optional(),
        node_name: z.string().optional(),
      },
    },
    async ({ cursor, limit, search, folder_id, folder_name, node_id, node_name }) => {
      const c = cursor ?? 0;
      const l = Math.min(limit ?? 20, 100);

      let resolvedFolderId = folder_id ?? null;
      if (folder_name && !folder_id) {
        const folders = await runtime.db.getAllFolders();
        const matched = folders.find((f) => f.name === folder_name);
        resolvedFolderId = matched ? matched.id : null;
      }
      const resolvedNodeId = node_id ?? node_name ?? null;

      const { sessions, total } = await runtime.db.listSessionsSummary({
        search: search ?? null,
        limit: l,
        offset: c,
        folderId: resolvedFolderId,
        nodeId: resolvedNodeId,
      });
      const hasMore = c + l < total;
      return jsonResult({
        total,
        sessions: sessions.map((s) => ({
          session_id: s.session_id,
          display_name: s.display_name,
          status: s.status,
          session_type: s.session_type,
          created_at: serializeDate(s.created_at),
          updated_at: serializeDate(s.updated_at),
          event_count: s.event_count,
          caller_session_id: s.caller_session_id,
          away_summary: s.away_summary,
        })),
        next_cursor: hasMore ? c + l : null,
      });
    },
  );

  server.registerTool(
    "list_session_events",
    {
      description:
        "세션 이벤트 목록 페이지네이션. tool_content로 tool_use/tool_result 길이 제어 (Python 정합).",
      inputSchema: {
        session_id: z.string(),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        tool_truncate_chars: z
          .number()
          .int()
          .min(0)
          .default(TOOL_TRUNCATE_DEFAULT),
        event_types: z.array(z.string()).optional(),
        tool_content: z
          .enum(["truncate", "full", "omit"])
          .default("truncate"),
      },
    },
    async ({ session_id, cursor, limit, tool_truncate_chars, event_types, tool_content }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const events = await runtime.db.readEvents(
        session_id,
        cursor ?? 0,
        limit ?? 20,
        event_types,
      );
      const processed = events.map((ev) =>
        applyToolContentPolicy(
          ev,
          tool_content ?? "truncate",
          tool_truncate_chars ?? TOOL_TRUNCATE_DEFAULT,
        ),
      );
      const last = events[events.length - 1];
      return jsonResult({
        session_id,
        events: processed,
        next_cursor: last ? last.id : (cursor ?? 0),
      });
    },
  );

  server.registerTool(
    "get_session_event",
    {
      description: "특정 이벤트의 전문(truncation 없음)을 조회.",
      inputSchema: {
        session_id: z.string(),
        event_id: z.number().int().positive(),
      },
    },
    async ({ session_id, event_id }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const ev = await runtime.db.readOneEvent(session_id, event_id);
      if (!ev) {
        return errorResult(
          `이벤트를 찾을 수 없습니다: session=${session_id}, event_id=${event_id}`,
        );
      }
      return jsonResult({ id: ev.id, event: ev.payload });
    },
  );

  server.registerTool(
    "download_session_history",
    {
      description:
        "세션의 전체 이벤트 히스토리를 JSONL 파일로 저장. default dir /tmp/soulstream_sessions/.",
      inputSchema: {
        session_id: z.string(),
        output_dir: z.string().optional(),
      },
    },
    async ({ session_id, output_dir }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const outDir = output_dir ?? DEFAULT_DOWNLOAD_DIR;
      mkdirSync(outDir, { recursive: true });
      const filePath = join(outDir, `session_${session_id}.jsonl`);
      const rows = await runtime.db.streamEventsRaw(session_id);
      const lines = rows
        .map((r) => {
          let parsedPayload: unknown = {};
          try {
            parsedPayload = JSON.parse(r.payload_text);
          } catch {
            parsedPayload = {};
          }
          return JSON.stringify({
            id: r.id,
            event_type: r.event_type,
            event: parsedPayload,
          });
        })
        .join("\n");
      writeFileSync(
        filePath,
        lines.length > 0 ? `${lines}\n` : "",
        "utf-8",
      );
      return jsonResult({
        session_id,
        file_path: filePath,
        event_count: rows.length,
      });
    },
  );

  server.registerTool(
    "search_session_history",
    {
      description:
        "이벤트 텍스트 검색 (Postgres ts_rank). BM25 정밀 알고리즘은 후속 카드.",
      inputSchema: {
        query: z.string().min(1),
        session_ids: z.array(z.string()).optional(),
        top_k: z.number().int().min(1).max(100).default(10),
      },
    },
    async ({ query, session_ids, top_k }) => {
      try {
        const matches = await runtime.db.searchEvents(
          query,
          session_ids ?? null,
          top_k ?? 10,
        );
        return jsonResult({
          results: matches.map((m) => ({
            session_id: m.session_id,
            event_id: m.id,
            score: m.score,
            preview: buildPreview(m.searchable_text, query),
            event_type: m.event_type,
          })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
    },
  );

  server.registerTool(
    "get_session_summary",
    {
      description: "세션의 턴별 요약 (LLM 미사용, DB 이벤트 순회).",
      inputSchema: {
        session_id: z.string(),
        max_response_chars: z.number().int().min(0).default(500),
      },
    },
    async ({ session_id, max_response_chars }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const totalEvents = await runtime.db.countEvents(session_id);
      // 본 카드는 단순 요약 — Python `_assemble_turns` 정밀 turn 합성은 후속 카드.
      // user_message/assistant_message 이벤트만 추려 마지막 200개에서 텍스트 발췌.
      const events = await runtime.db.readEvents(
        session_id,
        0,
        Math.min(totalEvents, 200),
        ["user_message", "assistant_message", "user_text", "assistant_text"],
      );
      const cap = max_response_chars ?? 500;
      const turns = events.map((ev) => ({
        event_id: ev.id,
        event_type: ev.event_type,
        text: truncate(
          extractTextFromPayload(ev.payload),
          cap > 0 ? cap : undefined,
        ),
        created_at: serializeDate(ev.created_at),
      }));
      return jsonResult({
        session_id,
        display_name: session.display_name,
        status: session.status,
        created_at: serializeDate(session.created_at),
        total_events: totalEvents,
        turns,
      });
    },
  );
}

function serializeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString();
}

function applyToolContentPolicy(
  ev: { id: number; event_type: string; payload: Record<string, unknown>; created_at: Date },
  policy: "truncate" | "full" | "omit",
  truncateChars: number,
): Record<string, unknown> {
  const isToolEvent =
    ev.event_type === "tool_use" || ev.event_type === "tool_result";
  let payload: Record<string, unknown> | string = ev.payload;
  if (isToolEvent) {
    if (policy === "omit") {
      payload = "(omitted)";
    } else if (policy === "truncate") {
      const text = JSON.stringify(ev.payload);
      payload =
        text.length > truncateChars
          ? `${text.slice(0, truncateChars)}…(truncated)`
          : text;
    }
  }
  return {
    id: ev.id,
    event_type: ev.event_type,
    event: payload,
    created_at: ev.created_at instanceof Date ? ev.created_at.toISOString() : ev.created_at,
  };
}

function buildPreview(text: string, query: string): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) {
    return text.slice(0, SEARCH_PREVIEW_RADIUS * 2);
  }
  const start = Math.max(0, idx - SEARCH_PREVIEW_RADIUS);
  const end = Math.min(text.length, idx + query.length + SEARCH_PREVIEW_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function extractTextFromPayload(payload: Record<string, unknown>): string {
  // 일반적 키 순서대로 시도. 없으면 JSON.stringify.
  for (const key of ["text", "content", "message", "value"]) {
    const v = payload[key];
    if (typeof v === "string") return v;
  }
  return JSON.stringify(payload);
}

function truncate(s: string, limit?: number): string {
  if (limit === undefined || limit === 0) return s;
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
