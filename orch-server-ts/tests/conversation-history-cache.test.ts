import { afterEach, describe, expect, it, vi } from "vitest";
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
  };
  const queries: Query[] = [];
  const add = (session: string, id: number, type: string, payload: Record<string, unknown> = {}) => {
    const rows = state.events.get(session) ?? [];
    rows.push({ id, event_type: type, payload, created_at: at });
    rows.sort((a, b) => a.id - b.id);
    state.events.set(session, rows);
  };
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
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
  }) as unknown as SqlClient;
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

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation history incremental projection cache", () => {
  it("matches a from-scratch load while events arrive between loads, and keeps earlier results as snapshots", async () => {
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);

    const first = await history.load(binding());
    const firstSnapshot = snapshot(first);
    expect(first.items.map(entry => entry.item.kind)).toEqual(["user", "assistant"]);
    expect(first.items[0]!.item.attachments).toEqual([{ id: "asset-1", name: "photo.png", mime: "image/png" }]);

    db.add("exec-1", 5, "user_message", { text: "캐시 유지", purpose: "cache_keepalive", input_id: "hidden" });
    db.add("exec-1", 6, "assistant_message", { content: "숨김", input_id: "hidden" });
    db.add("exec-1", 7, "error", { message: "실패" });
    db.add("exec-1", 8, "notification", { _conversation_notice: "알림" });
    db.add("exec-1", 9, "intervention_sent", { text: "두 번째 입력", caller_info: { source: "soul-app" } });
    db.add("exec-1", 10, "assistant_message", { content: "두 번째 답" });
    db.add("exec-1", 11, "complete", {});

    const incremental = await history.load(binding());
    const fresh = await new ConversationHistory(db.sql).load(binding());

    expect(snapshot(incremental)).toEqual(snapshot(fresh));
    expect(snapshot(first)).toEqual(firstSnapshot);
    expect(incremental.items.map(entry => entry.item.text)).toEqual(["첫 입력", "첫 답", "실패", "알림", "두 번째 입력", "두 번째 답"]);
    expect(incremental.items[0]!.item.attachments).toEqual([{ id: "asset-1", name: "photo.png", mime: "image/png" }]);
    expect(incremental.cursor).toBe(fresh.cursor);
    expect(incremental.projection.hasErrorInTurn()).toBe(false);
  });

  it("reads only events after the cached last id on the next load", async () => {
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);

    db.queries.length = 0;
    await history.load(binding());
    const initial = eventQueries(db.queries);
    expect(initial).toHaveLength(1);
    expect(initial[0]!.text).not.toContain("id >");

    db.add("exec-1", 5, "user_message", { text: "추가", caller_info: { source: "browser" } });
    db.add("exec-1", 6, "assistant_message", { content: "추가 답" });
    db.queries.length = 0;
    await history.load(binding());
    const incremental = eventQueries(db.queries);
    expect(incremental).toHaveLength(1);
    expect(incremental[0]!.text).toContain("id > ?");
    expect(incremental[0]!.values[1]).toBe(4);
    expect(incremental[0]!.values[2]).toBe(6);
  });

  it("serializes concurrent loads of the same execution and returns the same result", async () => {
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);

    const [first, second] = await Promise.all([history.load(binding()), history.load(binding())]);
    expect(snapshot(first)).toEqual(snapshot(second));
    expect(eventQueries(db.queries)).toHaveLength(1);

    db.add("exec-1", 5, "user_message", { text: "동시", caller_info: { source: "browser" } });
    db.queries.length = 0;
    const [third, fourth] = await Promise.all([history.load(binding()), history.load(binding())]);
    const incremental = eventQueries(db.queries);
    expect(snapshot(third)).toEqual(snapshot(fourth));
    expect(incremental).toHaveLength(1);
    expect(incremental[0]!.text).toContain("id > ?");
    expect(snapshot(third)).toEqual(snapshot(await new ConversationHistory(db.sql).load(binding())));
  });

  it("keeps at most 64 executions with least-recently-used eviction", async () => {
    const db = createDb();
    const history = new ConversationHistory(db.sql);
    const loadSession = async (session: string) => {
      db.state.executions = [{ session_id: session, ordinal: 1, first_input_is_initial_instruction: false }];
      return await history.load(binding(session));
    };
    for (let index = 0; index < 64; index += 1) {
      db.add(`exec-${index}`, 1, "user_message", { text: `메시지 ${index}`, caller_info: { source: "browser" } });
      await loadSession(`exec-${index}`);
    }

    db.queries.length = 0;
    await loadSession("exec-0");
    expect(eventQueries(db.queries)).toHaveLength(0);

    db.add("exec-64", 1, "user_message", { text: "메시지 64", caller_info: { source: "browser" } });
    await loadSession("exec-64");

    db.queries.length = 0;
    await loadSession("exec-1");
    const evicted = eventQueries(db.queries);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.text).not.toContain("id >");

    db.queries.length = 0;
    await loadSession("exec-0");
    expect(eventQueries(db.queries)).toHaveLength(0);
  });

  it("expires ten minutes after the cache entry was created, even when it is used", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);

    await history.load(binding());
    vi.setSystemTime(new Date("2026-11-17T00:05:00Z"));
    db.queries.length = 0;
    await history.load(binding());
    expect(eventQueries(db.queries)).toHaveLength(0);

    db.add("exec-1", 5, "user_message", { text: "9분 59초", caller_info: { source: "browser" } });
    vi.setSystemTime(new Date("2026-11-17T00:09:59Z"));
    db.queries.length = 0;
    const warm = await history.load(binding());
    expect(eventQueries(db.queries)[0]!.text).toContain("id > ?");

    vi.setSystemTime(new Date("2026-11-17T00:10:00Z"));
    db.queries.length = 0;
    const expired = await history.load(binding());
    const cold = eventQueries(db.queries);
    expect(cold).toHaveLength(1);
    expect(cold[0]!.text).not.toContain("id >");
    expect(snapshot(expired)).toEqual(snapshot(await new ConversationHistory(db.sql).load(binding())));
    expect(snapshot(warm).items).toEqual(snapshot(expired).items);
  });

  it("discards a partially applied entry when incremental enrichment fails", async () => {
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);
    await history.load(binding());

    db.add("exec-1", 5, "user_message", { text: "적용 뒤 실패", caller_info: { source: "browser" } });
    db.add("exec-1", 6, "user_message", { text: "실패 지점", caller_info: { source: "browser" }, attachment_ids: ["asset-1"] });
    db.state.failFileAssets = 1;
    await expect(history.load(binding())).rejects.toThrow("file_assets query failed");

    db.queries.length = 0;
    const recovered = await history.load(binding());
    const reads = eventQueries(db.queries);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.text).not.toContain("id >");
    expect(recovered.items.map(entry => entry.item.text)).toEqual(["첫 입력", "첫 답", "적용 뒤 실패", "실패 지점"]);
    expect(snapshot(recovered)).toEqual(snapshot(await new ConversationHistory(db.sql).load(binding())));
  });

  it("discards the cache when the event watermark moves backwards", async () => {
    const db = createDb();
    seedConversation(db);
    db.add("exec-1", 5, "user_message", { text: "사라질 입력", caller_info: { source: "browser" } });
    db.add("exec-1", 6, "assistant_message", { content: "사라질 답" });
    const history = new ConversationHistory(db.sql);
    await history.load(binding());

    db.state.events.set("exec-1", (db.state.events.get("exec-1") ?? []).filter(row => row.id <= 4));
    db.queries.length = 0;
    const rebuilt = await history.load(binding());
    const queries = eventQueries(db.queries);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).not.toContain("id >");
    expect(snapshot(rebuilt)).toEqual(snapshot(await new ConversationHistory(db.sql).load(binding())));

    db.add("exec-1", 7, "user_message", { text: "다시", caller_info: { source: "browser" } });
    db.queries.length = 0;
    const resumed = await history.load(binding());
    const incremental = eventQueries(db.queries);
    expect(incremental[0]!.text).toContain("id > ?");
    expect(incremental[0]!.values[1]).toBe(4);
    expect(snapshot(resumed)).toEqual(snapshot(await new ConversationHistory(db.sql).load(binding())));
  });

  it("keys the cache by the first-input option", async () => {
    const db = createDb();
    seedConversation(db);
    const history = new ConversationHistory(db.sql);
    await history.load(binding());

    db.state.executions = [{ session_id: "exec-1", ordinal: 1, first_input_is_initial_instruction: true }];
    db.queries.length = 0;
    const skipped = await history.load(binding());
    const queries = eventQueries(db.queries);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).not.toContain("id >");
    expect(skipped.items.map(entry => entry.item.text)).toEqual(["첫 답"]);
  });
});
