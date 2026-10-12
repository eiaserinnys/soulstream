import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";

const SINCE = new Date("2026-10-05T01:00:00.000Z");
const UNTIL = new Date("2026-10-05T02:00:00.000Z");
const at = (time: string) => new Date(`2026-10-05T${time}Z`);

type UsagePage = { rows: Record<string, unknown>[]; total: number };
type UsageSessionRow = Record<string, unknown>;

describe("EventReadRepository turn usage reads (real Postgres)", () => {
  let h: PagePostgresHarness;
  let repository: EventReadRepository;

  async function put(sessionId: string, id: number, eventType: string, createdAt: Date, payload: Record<string, unknown>) {
    await h.sql`INSERT INTO events(session_id, id, event_type, payload, created_at)
      VALUES (${sessionId}, ${id}, ${eventType}, ${h.sql.json(payload as never)}, ${createdAt})`;
  }

  async function listTurnUsage(query: Record<string, unknown>): Promise<UsagePage> {
    return await (repository as unknown as {
      listTurnUsage(value: Record<string, unknown>): Promise<UsagePage>;
    }).listTurnUsage(query);
  }

  async function summarizeTurnUsage(query: Record<string, unknown>): Promise<UsageSessionRow[]> {
    return await (repository as unknown as {
      summarizeTurnUsage(value: Record<string, unknown>): Promise<UsageSessionRow[]>;
    }).summarizeTurnUsage(query);
  }

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    repository = new EventReadRepository(h.sql);
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT`;
    await h.sql`INSERT INTO sessions(session_id, display_name, node_id, agent_id, model_preset, created_at)
      VALUES
        ('s-cl', 'Claude 세션', 'node-a', 'agent-a', 'claude-preset', ${at("01:00:00.000")}),
        ('s-old', '옛 세션', 'node-b', 'agent-b', 'old-preset', ${new Date("2026-10-01T00:00:00.000Z")}),
        ('s-codex', 'Codex 세션', 'node-c', 'agent-c', 'codex-preset', ${at("01:02:00.000")}),
        ('s-next', '다음 메시지 세션', 'node-d', 'agent-d', 'next-preset', ${at("01:03:00.000")})`;

    await put("s-cl", 1, "context_manifest", at("01:00:00.000"), { total_chars: 100 });
    await put("s-cl", 2, "context_manifest", at("01:00:01.000"), { total_chars: 110 });
    await put("s-cl", 3, "user_message", at("01:00:02.000"), { text: "turn one" });
    await put("s-cl", 4, "context_manifest", at("01:00:03.000"), { total_chars: 120 });
    await put("s-cl", 5, "complete", at("01:00:04.000"), {
      model: "claude-model",
      usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      turn_cost_usd: 0.1256789,
      first_call: { input_tokens: 8, cached_input_tokens: 1 },
    });
    await put("s-cl", 6, "result", at("01:00:05.000"), {
      success: true,
      usage: { input_tokens: 999, cached_input_tokens: 100, output_tokens: 999 },
    });
    await put("s-cl", 7, "user_message", at("01:10:00.000"), { text: "no usage" });
    await put("s-cl", 8, "context_manifest", at("01:10:01.000"), { total_chars: 130 });
    await put("s-cl", 9, "tool_start", at("01:10:02.000"), { tool_name: "read_file" });
    await put("s-cl", 10, "session_ended", at("01:10:03.000"), { termination_reason: "limit_hit" });
    await put("s-cl", 11, "user_message", at("01:20:00.000"), { text: "still running" });

    await put("s-old", 1, "user_message", at("01:02:00.000"), { text: "old format" });
    await put("s-old", 2, "complete", at("01:02:01.000"), { model: "old-model" });
    await put("s-old", 3, "session_ended", at("01:02:02.000"), { termination_reason: "completed" });

    await put("s-codex", 1, "user_message", at("01:03:00.000"), { text: "codex complete" });
    await put("s-codex", 2, "complete", at("01:03:01.000"), {
      model: "codex-model",
      usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 6 },
      turn_cost_usd: 0.5,
      first_call: { input_tokens: 11, cached_input_tokens: 2 },
    });
    await put("s-codex", 3, "user_message", at("01:04:00.000"), { text: "failed result" });
    await put("s-codex", 4, "result", at("01:04:01.000"), {
      success: false,
      model: "codex-model",
      usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 },
      turn_cost_usd: 0.25,
    });
    await put("s-codex", 5, "user_message", at("01:05:00.000"), { text: "failed error" });
    await put("s-codex", 6, "error", at("01:05:01.000"), {
      model: "codex-model",
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 1 },
      turn_cost_usd: 0.05,
    });

    await put("s-next", 1, "user_message", at("01:06:00.000"), { text: "closed by next message" });
    await put("s-next", 2, "user_message", at("01:07:00.000"), { text: "usage turn" });
    await put("s-next", 3, "complete", at("01:07:01.000"), {
      model: "next-model",
      usage: { input_tokens: 7, cache_read_input_tokens: 1, output_tokens: 2 },
      turn_cost_usd: 0.1,
    });
    await put("s-next", 4, "user_message", at("01:08:00.000"), { text: "open turn" });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("normalizes Claude and Codex rows, keeps failed usage, and counts only closed no-usage turns", async () => {
    const { rows, total } = await listTurnUsage({
      sessionId: undefined,
      since: SINCE,
      until: UNTIL,
      cursor: 0,
      limit: 100,
    });

    expect(total).toBe(8);
    expect(rows.map((row) => `${row.session_id}#${row.event_id}:${row.kind}`)).toEqual([
      "s-cl#5:complete",
      "s-old#1:no_usage",
      "s-codex#2:complete",
      "s-codex#4:failed",
      "s-codex#6:failed",
      "s-next#1:no_usage",
      "s-next#3:complete",
      "s-cl#7:no_usage",
    ]);
    expect(rows[0]).toMatchObject({
      input_tokens: 15,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      cost_usd: 0.1256789,
      first_call_input_tokens: 8,
      first_call_cached_tokens: 1,
      injection_chars: 120,
    });
    expect(rows[0]).not.toHaveProperty("ended");
    expect(rows[0]).not.toHaveProperty("tool_calls");
    expect(rows.find((row) => row.session_id === "s-codex" && row.event_id === 2)).toMatchObject({
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 6,
      cost_usd: 0.5,
      first_call_input_tokens: 11,
    });
    expect(rows.find((row) => row.session_id === "s-codex" && row.event_id === 2)).not.toHaveProperty("cache_write_tokens");
    expect(rows.find((row) => row.session_id === "s-codex" && row.event_id === 4)?.kind).toBe("failed");
    expect(rows.find((row) => row.session_id === "s-codex" && row.event_id === 6)?.kind).toBe("failed");
    expect(rows.find((row) => row.session_id === "s-cl" && row.event_id === 6)).toBeUndefined();

    const closedByEnd = rows.find((row) => row.session_id === "s-cl" && row.event_id === 7)!;
    expect(closedByEnd).toMatchObject({ kind: "no_usage", injection_chars: 120, ended: "limit_hit", tool_calls: 1 });
    expect(rows.find((row) => row.session_id === "s-old" && row.event_id === 1)).toMatchObject({
      kind: "no_usage",
      ended: "completed",
      tool_calls: 0,
    });
    expect(rows.find((row) => row.session_id === "s-next" && row.event_id === 1)).toMatchObject({
      kind: "no_usage",
      tool_calls: 0,
    });
    expect(rows.find((row) => row.session_id === "s-next" && row.event_id === 1)).not.toHaveProperty("ended");
    expect(rows.find((row) => row.session_id === "s-cl" && row.event_id === 11)).toBeUndefined();
  });

  it("uses one count for paging and session-only reads include the full session", async () => {
    const page = await listTurnUsage({
      sessionId: undefined,
      since: SINCE,
      until: UNTIL,
      cursor: 2,
      limit: 2,
    });
    expect(page.total).toBe(8);
    expect(page.rows.map((row) => `${row.session_id}#${row.event_id}`)).toEqual(["s-codex#2", "s-codex#4"]);

    const singleSession = await listTurnUsage({
      sessionId: "s-cl",
      since: undefined,
      until: UNTIL,
      cursor: 0,
      limit: 100,
    });
    expect(singleSession.total).toBe(2);
    expect(singleSession.rows.map((row) => row.kind)).toEqual(["complete", "no_usage"]);
    expect(singleSession.rows[0]).toMatchObject({
      name: "Claude 세션",
      agent_id: "agent-a",
      node_id: "node-a",
      model_preset: "claude-preset",
    });
  });

  it("returns one summary row per session, including sessions with only no-usage turns", async () => {
    const rows = await summarizeTurnUsage({ since: SINCE, until: UNTIL });

    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.session_id === "s-cl")).toMatchObject({
      turns: 1,
      turns_without_usage: 1,
      input_tokens: 15,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      cost_usd: 0.1256789,
      model: "claude-model",
      first_call_input_tokens: 8,
      injection_chars: 130,
      agent_id: "agent-a",
      node_id: "node-a",
      display_name: "Claude 세션",
    });
    expect(rows.find((row) => row.session_id === "s-old")).toMatchObject({ turns: 0, turns_without_usage: 1 });
    expect(rows.find((row) => row.session_id === "s-codex")).toMatchObject({ turns: 3, turns_without_usage: 0 });
    expect(rows.find((row) => row.session_id === "s-next")).toMatchObject({ turns: 1, turns_without_usage: 1 });
  });
});
