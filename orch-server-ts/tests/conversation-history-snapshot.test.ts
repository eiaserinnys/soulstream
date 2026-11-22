import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONVERSATION_HISTORY_PROJECTION_FINGERPRINT } from "../src/conversation/conversation_history_source.js";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { ConversationHistory } from "../src/conversation/conversation_history.js";
import type { Binding } from "../src/conversation/conversation_types.js";

type Query = { text: string; values: unknown[] };
type EventRow = { id: number; event_type: string; payload: Record<string, unknown> | null; created_at: Date };
type ExecutionRow = { session_id: string; ordinal: number; first_input_is_initial_instruction: boolean };

const at = new Date("2026-10-30T00:00:00Z");

function createDb() {
  const state = {
    executions: [] as ExecutionRow[],
    events: new Map<string, EventRow[]>(),
    assets: [] as Array<{ id: string; original_name: string; mime_type: string; upload_status: string; garbage_collected_at: Date | null }>,
    uploads: [] as Array<Record<string, unknown>>,
    failFileAssets: 0,
    failSnapshotWrite: false,
    snapshots: new Map<string, { projection_version: number; last_event_id: number; state: unknown; items: unknown }>(),
  };
  const queries: Query[] = [];
  const add = (session: string, id: number, type: string, payload: Record<string, unknown> = {}) => {
    const rows = state.events.get(session) ?? [];
    rows.push({ id, event_type: type, payload, created_at: at });
    rows.sort((a, b) => a.id - b.id);
    state.events.set(session, rows);
  };
  const sql = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = values[0] as { sqlFragment?: string } | undefined;
    const text = (fragment?.sqlFragment
      ? parts[0] + fragment.sqlFragment + parts.slice(1).join("?")
      : parts.join("?")).replace(/\s+/g, " ").trim();
    if (fragment?.sqlFragment) values.shift();
    queries.push({ text, values });
    if (text.includes("FROM conversation_history_snapshots")) {
      const key = String(values[0]) + ':' + String(values[1]);
      if (text.startsWith("DELETE")) { state.snapshots.delete(key); return []; }
      const row = state.snapshots.get(key);
      return row && row.projection_version === values[2] ? [structuredClone(row)] : [];
    }
    if (text.includes("INSERT INTO conversation_history_snapshots")) {
      if (state.failSnapshotWrite) throw new Error("snapshot write failed");
      const [session, flag, version, last, savedState, items] = values;
      const key = String(session) + ':' + String(flag);
      const old = state.snapshots.get(key);
      if (!old || old.projection_version !== version || old.last_event_id < (last as number)) {
        state.snapshots.set(key, structuredClone({ projection_version: version as number, last_event_id: last as number, state: savedState, items }));
      }
      return [];
    }
    if (text.includes("FROM conversation_executions")) return state.executions;
    if (text.includes("MAX(id)")) {
      const rows = state.events.get(values[0] as string) ?? [];
      return [{ id: rows.reduce((max, row) => Math.max(max, row.id), 0) }];
    }
    if (text.includes("FROM events")) {
      const incremental = text.includes("id >");
      const session = values[0] as string;
      const after = incremental ? values[1] as number : 0;
      const before = values[incremental ? 2 : 1] as number;
      const types = values[incremental ? 3 : 2] as readonly string[];
      return (state.events.get(session) ?? []).filter(row => row.id > after && row.id <= before && types.includes(row.event_type));
    }
    if (text.includes("conversation_message_receipts")) {
      const paths = values[0] as readonly string[];
      return state.uploads.filter(upload => paths.includes(upload.path as string)).map(upload => ({ upload }));
    }
    if (text.includes("FROM file_assets")) {
      if (state.failFileAssets > 0) {
        state.failFileAssets -= 1;
        throw new Error("file_assets query failed");
      }
      const ids = values[0] as readonly string[];
      return state.assets.filter(asset => ids.includes(asset.id)
        && asset.upload_status === "committed" && asset.garbage_collected_at === null);
    }
    throw new Error(`unexpected query: ${text}`);
  }, { unsafe: (sqlFragment: string) => ({ sqlFragment }), json: (value: unknown) => value }) as unknown as SqlClient;
  return { state, queries, add, sql };
}

function binding(session = "exec-1"): Binding {
  return {
    account_id: "person", namespace: "n", external_key: "k", session_id: session, active_session_id: null,
    selected_model: "sol", creation_request: null, phase: "complete", instruction_id: null, notices: [],
    archived: false, first_input_is_initial_instruction: false,
  } as Binding;
}

function snapshot(result: Awaited<ReturnType<ConversationHistory["load"]>>) {
  return {
    cursor: result.cursor,
    items: result.items.map(entry => ({ position: entry.position, session: entry.session, item: entry.item })),
    activity: result.projection.activity(),
    stream: result.projection.stream(),
    hasErrorInTurn: result.projection.hasErrorInTurn(),
    allowsLive: result.projection.allowsLive(),
    active: result.active,
    state: result.projection.snapshot(),
  };
}

function eventQueries(queries: readonly Query[]) {
  return queries.filter(query => query.text.includes("FROM events") && !query.text.includes("MAX(id)"));
}

function seedConversation(db: ReturnType<typeof createDb>) {
  db.state.executions = [{ session_id: "exec-1", ordinal: 1, first_input_is_initial_instruction: false }];
  db.state.assets = [{ id: "asset-1", original_name: "photo.png", mime_type: "image/png", upload_status: "committed", garbage_collected_at: null }];
  db.state.uploads = [{ path: "/tmp/a.png", name: "a.png", mime: "image/png", assetId: "asset-1" }];
  db.add("exec-1", 1, "user_message", { text: "첫 입력", caller_info: { source: "browser" }, attachments: ["/tmp/a.png"], attachment_ids: ["asset-1"] });
  db.add("exec-1", 2, "assistant_message", { content: "첫 답" });
  db.add("exec-1", 3, "tool_start", { tool_name: "Read" });
  db.add("exec-1", 4, "complete", {});
}

describe("conversation history persisted snapshots", () => {
  it("restores a mid-turn snapshot and reads only subsequent events", async () => {
    const db = createDb();
    seedConversation(db);
    db.add("exec-1", 998, "user_message", { text: "진행 중", caller_info: { source: "browser" } });
    db.add("exec-1", 999, "user_message", { text: "보이지 않는 입력", purpose: "cache_keepalive", input_id: "hidden" });
    db.add("exec-1", 1000, "tool_start", { tool_name: "숨김", input_id: "hidden" });
    const first = await new ConversationHistory(db.sql).load(binding());
    expect(first.projection.activity().busy).toBe(true);
    expect(db.state.snapshots.get("exec-1:false")?.last_event_id).toBe(1000);
    db.add("exec-1", 1001, "assistant_message", { content: "숨김", input_id: "hidden" });
    db.add("exec-1", 1002, "user_message", { text: "다음", caller_info: { source: "browser" } });
    db.add("exec-1", 1003, "tool_start", { tool_name: "Read" });
    db.queries.length = 0;
    const restored = await new ConversationHistory(db.sql).load(binding());
    const reads = eventQueries(db.queries);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.text).toContain("id > ?");
    expect(reads[0]!.values[1]).toBe(1000);
    db.state.snapshots.clear();
    const fresh = await new ConversationHistory(db.sql).load(binding());
    expect(snapshot(restored)).toEqual(snapshot(fresh));
    expect(restored.projection.activity()).toEqual({ busy: true, tool: "Read" });
  });

  it("writes after 1000 ids of progress and waits for another 1000", async () => {
    const db = createDb();
    db.add("exec-1", 999, "user_message", { text: "첫 입력", caller_info: { source: "browser" } });
    const history = new ConversationHistory(db.sql);
    await history.load(binding());
    expect(db.state.snapshots.size).toBe(0);
    db.add("exec-1", 1000, "complete");
    await history.load(binding());
    expect(db.state.snapshots.get("exec-1:false")?.last_event_id).toBe(1000);
    db.add("exec-1", 1999, "complete");
    await history.load(binding());
    expect(db.state.snapshots.get("exec-1:false")?.last_event_id).toBe(1000);
    db.add("exec-1", 2000, "complete");
    await history.load(binding());
    expect(db.state.snapshots.get("exec-1:false")?.last_event_id).toBe(2000);
  });

  it("rebuilds for a different version or a snapshot beyond the watermark", async () => {
    const db = createDb();
    seedConversation(db);
    db.add("exec-1", 1000, "complete");
    await new ConversationHistory(db.sql).load(binding());
    const saved = db.state.snapshots.get("exec-1:false")!;
    saved.projection_version = 999;
    db.queries.length = 0;
    await new ConversationHistory(db.sql).load(binding());
    expect(eventQueries(db.queries)[0]!.text).not.toContain("id >");
    const current = db.state.snapshots.get("exec-1:false")!;
    current.last_event_id = 1001;
    db.queries.length = 0;
    await new ConversationHistory(db.sql).load(binding());
    expect(db.queries.some(q => q.text.startsWith("DELETE FROM conversation_history_snapshots"))).toBe(true);
    expect(eventQueries(db.queries)[0]!.text).not.toContain("id >");
  });

  it("rebuilds malformed snapshots and keeps loading when snapshot operations fail", async () => {
    const db = createDb();
    seedConversation(db);
    db.add("exec-1", 1000, "complete");
    await new ConversationHistory(db.sql).load(binding());
    db.state.snapshots.get("exec-1:false")!.state = {};
    db.queries.length = 0;
    await new ConversationHistory(db.sql).load(binding());
    expect(db.queries.some(q => q.text.startsWith("DELETE FROM conversation_history_snapshots"))).toBe(true);
    expect(eventQueries(db.queries)[0]!.text).not.toContain("id >");
    db.state.snapshots.clear();
    db.state.failSnapshotWrite = true;
    const warn = vi.fn();
    const result = await new ConversationHistory(db.sql, { warn }).load(binding());
    expect(result.items).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it("enriches multiple rows in at most one receipt and asset query each", async () => {
    const db = createDb();
    seedConversation(db);
    db.state.assets.push({ id: "asset-2", original_name: "second.txt", mime_type: "text/plain", upload_status: "committed", garbage_collected_at: null });
    db.state.uploads.push({ path: "/tmp/b.txt", name: "B.txt", mime: "text/plain" });
    db.add("exec-1", 5, "user_message", { text: "둘째", caller_info: { source: "browser" }, attachments: ["/tmp/b.txt"], attachment_ids: ["asset-2", "asset-1", "asset-2", "missing"] });
    const result = await new ConversationHistory(db.sql).load(binding());
    expect(db.queries.filter(q => q.text.includes("FROM conversation_message_receipts"))).toHaveLength(1);
    expect(db.queries.filter(q => q.text.includes("FROM file_assets"))).toHaveLength(1);
    expect(result.items[0]!.item.attachments).toEqual([{ id: "asset-1", name: "photo.png", mime: "image/png" }]);
    expect(result.items[2]!.item.attachments).toEqual([
      { id: "asset-2", name: "second.txt", mime: "text/plain" }, { id: "asset-1", name: "photo.png", mime: "image/png" },
      { id: "path:0", name: "B.txt", mime: "text/plain" },
    ]);
  });
});

it("pins the projection fingerprint to the source files", () => {
  const files = [
    new URL("../src/conversation/conversation_history_source.ts", import.meta.url),
    new URL("../src/conversation/conversation_projection.ts", import.meta.url),
    new URL("../../packages/wire-schema/src/conversation_visibility.ts", import.meta.url),
  ];
  const contents = files.map(file => readFileSync(file, "utf8").replace(/^export const CONVERSATION_HISTORY_PROJECTION_FINGERPRINT = .*\n/m, ""));
  const fingerprint = (values: string[]) => createHash("sha256").update(values.join("")).digest("hex");
  expect(fingerprint(contents), "투영 결과를 정하는 코드가 바뀌면 버전을 올리고 지문을 고친다").toBe(CONVERSATION_HISTORY_PROJECTION_FINGERPRINT);
  expect(fingerprint([contents[0]! + "changed", ...contents.slice(1)])).not.toBe(CONVERSATION_HISTORY_PROJECTION_FINGERPRINT);
});

it("batches attachment lookups separately for each execution", async () => {
  const db = createDb();
  seedConversation(db);
  db.state.executions.push({ session_id: "exec-2", ordinal: 2, first_input_is_initial_instruction: false });
  db.add("exec-2", 1, "user_message", { text: "다음 실행", caller_info: { source: "browser" }, attachments: ["/tmp/a.png"], attachment_ids: ["asset-1"] });
  db.add("exec-2", 2, "user_message", { text: "같은 실행의 첨부", caller_info: { source: "browser" }, attachments: ["/tmp/a.png"], attachment_ids: ["asset-1"] });
  const result = await new ConversationHistory(db.sql).load(binding());
  expect(result.items).toHaveLength(4);
  const batches: Query[][] = [];
  for (const query of db.queries) {
    if (eventQueries([query]).length) batches.push([]);
    if (batches.length) batches.at(-1)!.push(query);
  }
  expect(batches).toHaveLength(2);
  for (const batch of batches) {
    expect(batch.filter(q => q.text.includes("FROM conversation_message_receipts"))).toHaveLength(1);
    expect(batch.filter(q => q.text.includes("FROM file_assets"))).toHaveLength(1);
  }
});
