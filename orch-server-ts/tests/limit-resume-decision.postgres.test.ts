import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import {
  decideResumeDispatch,
  type ResumeDispatchFacts,
  type ResumeDispatchSessionRow,
} from "../src/schedule/resume_dispatch_decision.js";
import { SoulstreamScheduleRepository } from "../src/schedule/schedule_repository.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

const describePostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe
  : describe.skip;

const limitSession = (overrides: Partial<ResumeDispatchSessionRow> = {}): ResumeDispatchSessionRow => ({
  status: "error",
  terminationReason: "limit_hit",
  terminalEventId: 11,
  ...overrides,
});

describe("resume dispatch decision cells", () => {
  const cases: Array<{
    name: string;
    facts: ResumeDispatchFacts;
    expected: ReturnType<typeof decideResumeDispatch>;
  }> = [
    {
      name: "세션 없음",
      facts: {
        originalTerminalEventId: 11,
        session: null,
        continuousLimitWindow: true,
        localTaskBusy: false,
      },
      expected: { decision: "close", reason: "session_missing" },
    },
    {
      name: "사람이 다시 시작해 정상으로 끝남",
      facts: {
        originalTerminalEventId: 11,
        session: limitSession({ status: "completed", terminationReason: "completed_ok", terminalEventId: 15 }),
        continuousLimitWindow: false,
        localTaskBusy: false,
      },
      expected: { decision: "close", reason: "current_session_not_limit_hit" },
    },
    {
      name: "새 한도로 다시 끝남",
      facts: {
        originalTerminalEventId: 11,
        session: limitSession({ terminalEventId: 21 }),
        continuousLimitWindow: false,
        localTaskBusy: false,
      },
      expected: { decision: "close", reason: "limit_window_or_terminal_chain_changed" },
    },
    {
      name: "로컬 task 바쁨",
      facts: {
        originalTerminalEventId: 11,
        session: limitSession({ terminalEventId: 13 }),
        continuousLimitWindow: true,
        localTaskBusy: true,
      },
      expected: { decision: "defer", reason: "local_task_busy" },
    },
    {
      name: "되돌림이 낀 사슬",
      facts: {
        originalTerminalEventId: 11,
        session: limitSession({ terminalEventId: 13 }),
        continuousLimitWindow: true,
        localTaskBusy: false,
      },
      expected: { decision: "fire", reason: null },
    },
    {
      name: "이미 깨어 있음",
      facts: {
        originalTerminalEventId: 11,
        session: limitSession({ status: "running", terminationReason: null, terminalEventId: null }),
        continuousLimitWindow: true,
        localTaskBusy: false,
      },
      expected: { decision: "close", reason: "session_already_awake" },
    },
    {
      name: "예약 신원이 깨짐",
      facts: {
        originalTerminalEventId: null,
        session: limitSession(),
        continuousLimitWindow: true,
        localTaskBusy: false,
      },
      expected: { decision: "close", reason: "invalid_original_revision" },
    },
  ];
  for (const { name, facts, expected } of cases) {
    it(name, () => {
      expect(decideResumeDispatch(facts)).toEqual(expected);
    });
  }
});

describePostgres("ResumeAfterLimit wake decision for a card-less session", () => {
  let h: PagePostgresHarness;
  let repo: SoulstreamScheduleRepository;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql.unsafe(`
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS card_id TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_reason TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_event_id INTEGER;
      CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, value JSONB NOT NULL);
      CREATE TABLE soulstream_schedules (
        schedule_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
        status TEXT NOT NULL CHECK (
          status IN ('active', 'dispatching', 'firing', 'completed', 'cancelled', 'failed', 'orphaned')
        ),
        prompt TEXT NOT NULL,
        source_tool TEXT NOT NULL,
        tool_use_id TEXT,
        cron_expression TEXT,
        run_once_at TIMESTAMPTZ,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        recurring BOOLEAN NOT NULL DEFAULT FALSE,
        next_run_at TIMESTAMPTZ,
        last_fired_at TIMESTAMPTZ,
        fired_count INTEGER NOT NULL DEFAULT 0,
        dispatch_failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claim_token TEXT,
        claimed_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    repo = new SoulstreamScheduleRepository(createFolderContentSqlAdapter(h.liveSql));
  }, 60_000);

  afterAll(async () => {
    if (h) await h.cleanup();
  }, 15_000);

  beforeEach(async () => {
    await h.sql`TRUNCATE soulstream_schedules, events, sessions CASCADE`;
  });

  it("fires after a limit end, a resume execution, and a compensation end", async () => {
    const sessionId = "sess-compensated-resume";
    await h.sql`
      INSERT INTO sessions (session_id, node_id, status, termination_reason, termination_event_id, card_id)
      VALUES (${sessionId}, 'node-a', 'error', 'limit_hit', 13, NULL)
    `;
    const resetsAt = "2026-09-28T14:50:00Z";
    for (const [id, eventType, payload, dedupeKey] of [
      [10, "credential_alert", { status: "rejected", resets_at: resetsAt }, null],
      [11, "session_ended", { termination_reason: "limit_hit" }, null],
      [12, "user_message", { text: "resume after the limit" }, null],
      [13, "session_ended", { termination_reason: "limit_hit" },
        `resume_compensation:${sessionId}:12`],
    ] as const) {
      await h.sql`
        INSERT INTO events (session_id, id, event_type, payload, dedupe_key)
        VALUES (${sessionId}, ${id}, ${eventType}, ${h.sql.json(payload)}::jsonb, ${dedupeKey})
      `;
    }
    const schedule = await repo.createSchedule({
      scheduleId: `resume-after-limit:${sessionId}:11:0`,
      sessionId,
      kind: "wakeup",
      prompt: "scheduled prompt",
      sourceTool: "ResumeAfterLimit",
      toolUseId: "ResumeAfterLimit:11",
      recurring: false,
      runOnceAt: new Date("2026-09-28T14:50:00Z"),
      nextRunAt: new Date("2026-09-28T14:50:00Z"),
    });

    expect(await repo.decideResumeDispatch(schedule, false)).toEqual({
      decision: "fire",
      reason: null,
    });
    // Old workers still ask the previous operation; it has to agree.
    expect(await repo.hasContinuousLimitWindow(schedule, 13)).toBe(true);
  });
});
