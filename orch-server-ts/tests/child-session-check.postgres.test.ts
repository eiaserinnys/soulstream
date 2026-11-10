import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  CHILD_SESSION_CHECK_TARGETS_SQL,
  ChildSessionCheckRepository,
} from "../src/session/child_session_check_repository.js";
import {
  CHILD_SESSION_CHECK_MAX_PER_CHECK,
  CHILD_SESSION_CHECK_THRESHOLD_MS,
  ChildSessionCheckService,
  type ChildSessionCheckDelivery,
} from "../src/session/child_session_check_service.js";
import { prepareCardReminderSchema } from "./card-reminder-postgres-fixture.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const IDLE_MS = 10 * 60_000;

describe("child session check against postgres", () => {
  let h: PagePostgresHarness;
  let repo: ChildSessionCheckRepository;
  let now: number;
  const delivered: ChildSessionCheckDelivery[] = [];
  const warnings: string[] = [];

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardReminderSchema(h);
    await h.sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_preset TEXT`;
    await h.sql`CREATE INDEX IF NOT EXISTS events_session_type_id ON events(session_id, event_type, id)`;
    repo = new ChildSessionCheckRepository(async () => h.sql as unknown as SqlClient);
  }, 60_000);

  beforeEach(async () => {
    await h.sql`TRUNCATE sessions, session_deliveries RESTART IDENTITY CASCADE`;
    delivered.length = 0;
    warnings.length = 0;
    now = Date.parse("2026-11-10T20:05:00+09:00");
    // 전달 행의 target_session_id가 sessions를 참조하므로 담당 세션을 만든다. caller가 없어 대상은 아니다.
    await seedSession({ id: "root", caller: null });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  function makeService(
    deliver: (input: ChildSessionCheckDelivery) => Promise<void>,
  ): ChildSessionCheckService {
    return new ChildSessionCheckService({
      store: repo,
      deliver,
      warn: (message) => { warnings.push(message); },
      nowMs: () => now,
    });
  }

  async function deliverAndRegister(input: ChildSessionCheckDelivery): Promise<void> {
    await insertDelivery(input.deliveryId, input.callerSessionId, now);
    delivered.push(input);
  }

  async function insertDelivery(deliveryId: string, callerSessionId: string, atMs: number): Promise<void> {
    await h.sql`INSERT INTO session_deliveries(
        delivery_id, target_session_id, relation_key, intent, source, payload_hash, state, aggregate_state, created_at
      ) VALUES (
        ${deliveryId}, ${callerSessionId}, ${deliveryId}, 'human_live_steer', 'child_session_check',
        ${"a".repeat(64)}, 'pending', 'pending', ${new Date(atMs)}
      )`;
  }

  type SessionSeed = {
    id: string;
    status?: string;
    caller?: string | null;
    notify?: boolean;
    createdAt?: number;
  };

  async function seedSession(seed: SessionSeed): Promise<void> {
    await h.sql`INSERT INTO sessions(
        session_id, node_id, display_name, agent_id, model_preset, status, caller_session_id,
        notify_completion, created_at, updated_at
      ) VALUES (
        ${seed.id}, 'node-a', ${`세션 ${seed.id}`}, 'roselin', 'deepseek-v4.1-flash',
        ${seed.status ?? "running"}, ${seed.caller === undefined ? "root" : seed.caller}, ${seed.notify ?? true},
        ${new Date(seed.createdAt ?? now - 60 * 60_000)}, ${new Date(seed.createdAt ?? now - 60 * 60_000)}
      )`;
  }

  async function seedEvent(
    sessionId: string,
    id: number,
    eventType: string,
    atMs: number,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await h.sql`INSERT INTO events(session_id, id, event_type, payload, created_at)
      VALUES (${sessionId}, ${id}, ${eventType}, ${h.sql.json(payload as never)}::jsonb, ${new Date(atMs)})`;
  }

  it("selects only running sessions with a distinct caller and notifications on", async () => {
    await seedSession({ id: "target" });
    await seedSession({ id: "paused", status: "completed" });
    await seedSession({ id: "no-caller", caller: null });
    await seedSession({ id: "muted", notify: false });
    await h.sql`INSERT INTO sessions(session_id, status, caller_session_id, notify_completion, created_at)
      VALUES ('self', 'running', 'self', TRUE, ${new Date(now - 60 * 60_000)})`;

    const targets = await repo.listTargets();
    expect(targets.map((target) => target.childSessionId)).toEqual(["target"]);
    expect(targets[0]).toMatchObject({
      callerSessionId: "root",
      displayName: "세션 target",
      agentId: "roselin",
      modelPreset: "deepseek-v4.1-flash",
      nodeId: "node-a",
      lastValidEventId: null,
      lastValidEventAtMs: null,
    });
    expect(targets[0]!.sessionCreatedAtMs).toBe(now - 60 * 60_000);
  });

  it.each([
    ["progress", { text: "still working" }, false],
    ["debug", { text: "trace" }, false],
    ["subagent_start", { subagent_id: "s" }, false],
    ["system_message", { text: "hook" }, false],
    ["progress", { foreground_tool_use_id: "" }, false],
    ["progress", { foreground_tool_use_id: 5 }, false],
    ["text_delta", { text: "x" }, false],
    ["progress", { foreground_tool_use_id: "toolu-foreground" }, true],
    ["tool_result", { tool_use_id: "toolu-1" }, true],
    ["complete", {}, true],
  ])("classifies %s %j as a valid response: %s", async (eventType, payload, valid) => {
    await seedSession({ id: "child" });
    await seedEvent("child", 1, eventType, now - 60_000, payload);

    const targets = await repo.listTargets();
    if (valid) {
      expect(targets[0]).toMatchObject({
        lastValidEventId: 1,
        lastValidEventType: eventType,
        lastValidEventAtMs: now - 60_000,
      });
    } else {
      expect(targets[0]).toMatchObject({
        lastValidEventId: null,
        lastValidEventType: null,
        lastValidEventAtMs: null,
      });
    }
  });

  it("keeps the newest valid response when ordinary progress keeps arriving", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 1, "assistant_message", now - 20 * 60_000);
    for (let index = 0; index < 500; index += 1) {
      await seedEvent("child", 100 + index, "progress", now - 60_000 + index, { text: "tick" });
    }

    const targets = await repo.listTargets();
    expect(targets[0]).toMatchObject({
      lastValidEventId: 1,
      lastValidEventType: "assistant_message",
      lastValidEventAtMs: now - 20 * 60_000,
    });
    await expect(repo.latestEvent("child")).resolves.toMatchObject({
      id: 599,
      eventType: "progress",
    });
  });

  it("sends one check per silent span and never re-registers after a restart", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 7, "tool_result", now - IDLE_MS);
    now += CHILD_SESSION_CHECK_THRESHOLD_MS - IDLE_MS + 1;

    const first = makeService(deliverAndRegister);
    await first.checkOnce();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      callerSessionId: "root",
      childSessionId: "child",
      deliveryId: "child-check:child:root:event:7",
    });

    await first.checkOnce();
    const restarted = makeService(deliverAndRegister);
    await restarted.checkOnce();
    expect(delivered).toHaveLength(1);
  });

  it("suppresses a new check when a registered delivery is newer than the known last response", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 7, "tool_result", now - IDLE_MS);
    now += CHILD_SESSION_CHECK_THRESHOLD_MS - IDLE_MS + 1;

    // 실시간 text 이벤트를 잃은 재시작을 흉내 낸다. token이 live에서 바뀌어도 등록 시각이 더 늦으면 보내지 않는다.
    await insertDelivery("child-check:child:root:live:1700000000000", "root", now);
    await makeService(deliverAndRegister).checkOnce();
    expect(delivered).toHaveLength(0);
  });

  it("does not register again when the dispatch failed after registering", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 7, "tool_result", now - IDLE_MS);
    now += CHILD_SESSION_CHECK_THRESHOLD_MS - IDLE_MS + 1;

    const failing = makeService(async (input) => {
      await insertDelivery(input.deliveryId, input.callerSessionId, now);
      throw new Error("node rejected intervention");
    });
    await failing.checkOnce();
    expect(warnings).toHaveLength(1);

    await makeService(deliverAndRegister).checkOnce();
    expect(delivered).toHaveLength(0);
  });

  it("defers on a live text delta that arrived after the last stored response", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 7, "tool_result", now - IDLE_MS);

    const service = makeService(deliverAndRegister);
    service.acceptNodeEvents([{
      type: "node_session_event",
      nodeId: "node-a",
      data: { type: "event", agentSessionId: "child", event: { type: "text_delta", text: "x" } },
    }]);
    await service.checkOnce();
    expect(delivered).toHaveLength(0);

    now += CHILD_SESSION_CHECK_THRESHOLD_MS + 1;
    await service.checkOnce();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.deliveryId).toMatch(/^child-check:child:root:live:\d+$/);
  });

  it("sends at most ten checks and leaves the remaining two for the next round", async () => {
    for (let index = 0; index < 12; index += 1) {
      const id = `child-${String(index).padStart(2, "0")}`;
      await seedSession({ id });
      await seedEvent(id, 1, "tool_result", now - IDLE_MS - (11 - index) * 60_000);
    }

    const service = makeService(deliverAndRegister);
    await service.checkOnce();
    expect(delivered).toHaveLength(CHILD_SESSION_CHECK_MAX_PER_CHECK);
    expect(delivered.map((input) => input.childSessionId)).toEqual([
      "child-00", "child-01", "child-02", "child-03", "child-04",
      "child-05", "child-06", "child-07", "child-08", "child-09",
    ]);

    await service.checkOnce();
    expect(delivered.slice(10).map((input) => input.childSessionId)).toEqual([
      "child-10", "child-11",
    ]);
  });

  it("records the plan for the target selection query", async () => {
    await seedSession({ id: "child" });
    await seedEvent("child", 1, "assistant_message", now - IDLE_MS);
    const rows = await h.sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${CHILD_SESSION_CHECK_TARGETS_SQL}`);
    const plan = rows
      .map((row: Record<string, unknown>) => String(row["QUERY PLAN"] ?? Object.values(row)[0] ?? ""))
      .join("\n");
    console.log(`CHILD_SESSION_CHECK_TARGETS_SQL plan:\n${plan}`);
    expect(plan).toContain("sessions");
  });
});
