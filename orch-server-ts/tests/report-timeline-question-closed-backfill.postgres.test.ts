import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";

const backfillSql = readFileSync(
  new URL("../../packages/db-schema/sql/backfills/20261112_report_timeline_question_closed.sql", import.meta.url),
  "utf8",
);

describe("report timeline question closed backfill", () => {
  let sql: ReturnType<typeof postgres>;
  let url: string;
  let stop: () => void;

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "question_closed_backfill", password: "question_closed_backfill", database: "question_closed_backfill_db",
    });
    stop = container.stop;
    url = `postgres://question_closed_backfill:question_closed_backfill@127.0.0.1:${container.port}/question_closed_backfill_db`;
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      await bootstrap.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    } finally { await bootstrap.end({ timeout: 2 }); }
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    await sql`INSERT INTO folders(id,name) VALUES ('backfill-folder','백필')`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id) VALUES
      ('backfill-pas','backfill-folder','test-node','test-agent')`;
    await sql`INSERT INTO cards(id,folder_id,position_key,title) VALUES
      ('card-answered','backfill-folder','a','답한 카드'),
      ('card-withdrawn','backfill-folder','b','철회한 카드'),
      ('card-open','backfill-folder','c','열린 카드'),
      ('card-mixed','backfill-folder','d','섞인 카드')`;
    await sql`INSERT INTO card_questions(id,card_id,text,answer,asked_at,answered_at) VALUES
      ('q-answered','card-answered','어느 쪽으로 갈까요?','진행','2026-11-01T00:00:00Z','2026-11-01T00:30:00Z'),
      ('q-mixed-answered','card-mixed','먼저 답한 질문','좋아요','2026-11-01T05:00:00Z','2026-11-01T05:30:00Z')`;
    await sql`INSERT INTO card_questions(id,card_id,text,asked_at,withdrawn_at,withdrawal_reason) VALUES
      ('q-withdrawn','card-withdrawn','다른 질문 글','2026-11-01T02:00:00Z','2026-11-01T02:30:00Z','정리')`;
    await sql`INSERT INTO card_questions(id,card_id,text,asked_at) VALUES
      ('q-open','card-open','아직 열린 질문','2026-11-01T04:00:00Z'),
      ('q-mixed-open','card-mixed','아직 열린 질문','2026-11-01T06:00:00Z')`;
    const line = async (cardId: string, detail: string, createdAt: string, extra: Record<string, unknown> = {}) => {
      const payload = { type: "report_timeline", line_key: `card:${cardId}`, status: "question",
        title: "옛 질문", detail, card_id: cardId, card_number: 1, ...extra };
      await sql`SELECT event_append('backfill-pas','report_timeline',${JSON.stringify(payload)},'',${createdAt}::timestamptz,NULL)`;
    };
    await line("card-answered", "어느 쪽으로 갈까요?", "2026-11-01T00:00:01Z");
    await line("card-withdrawn", "다른 질문 글", "2026-11-01T02:00:01Z");
    await line("card-open", "아직 열린 질문", "2026-11-01T04:00:01Z");
    await line("card-mixed", "먼저 답한 질문", "2026-11-01T05:00:01Z");
    await line("card-mixed", "아직 열린 질문", "2026-11-01T06:00:01Z");
    await line("card-answered", "이미 question_id가 있는 줄", "2026-11-01T01:00:00Z", { question_id: "q-answered" });
  }, 90_000);

  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  const closures = async () => await sql<{ id: number; payload: Record<string, unknown> }[]>`
    SELECT id,payload FROM events
    WHERE session_id='backfill-pas' AND event_type='report_timeline_question_closed'
    ORDER BY id`;

  // 백필 파일은 BEGIN/COMMIT을 직접 들고 있어 풀 연결이 아닌 연결 하나짜리 클라이언트로 psql처럼 실행한다.
  const runBackfill = async () => {
    const single = postgres(url, { max: 1, onnotice: () => undefined });
    try { await single.unsafe(backfillSql); } finally { await single.end({ timeout: 2 }); }
  };

  it("adds one event carrying only the closed question lines and stays stable on re-run", async () => {
    await runBackfill();
    const rows = await closures();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({
      type: "report_timeline_question_closed",
      closures: [
        { question_id: "q-answered", line_key: "card:card-answered", detail: "어느 쪽으로 갈까요?", status: "answered" },
        { question_id: "q-withdrawn", line_key: "card:card-withdrawn", detail: "다른 질문 글", status: "withdrawn" },
        { question_id: "q-mixed-answered", line_key: "card:card-mixed", detail: "먼저 답한 질문", status: "answered" },
      ],
    });
    await runBackfill();
    expect(await closures()).toHaveLength(1);
  });
});
