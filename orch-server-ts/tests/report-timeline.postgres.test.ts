import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";
import { createReportTimelineAppender } from "../src/session/report_timeline_publisher.js";
import type { ReportTimelineLine } from "../../packages/wire-schema/src/persistent_report.js";

describe("PAS report timeline on production PostgreSQL schema", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: () => void;
  let adapted: ReturnType<typeof createBoardYjsSqlAdapter>;
  let dbPort: ConstructorParameters<typeof CardControlPlaneService>[1];
  const hub = { publish: vi.fn() };
  const warn = vi.fn();
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  let connectedSessionNumber = 0;
  const line: ReportTimelineLine = {
    line_key: "report:example", status: "report", title: "준비 완료", detail: "확인했습니다",
    card_id: null, card_number: null,
  };
  const appender = createReportTimelineAppender({
    resolveSql: async () => sql as never,
    eventHub: hub as never,
    warn,
  });

  beforeAll(async () => {
    const container = startPostgresTestContainer({ user: "pas_timeline_test", password: "pas_timeline_test", database: "pas_timeline_test_db" });
    stop = container.stop;
    const url = `postgres://pas_timeline_test:pas_timeline_test@127.0.0.1:${container.port}/pas_timeline_test_db`;
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      await bootstrap.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    } finally { await bootstrap.end({ timeout: 2 }); }
    sql = postgres(url, { max: 4, onnotice: () => undefined });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES ('timeline-folder','타임라인')`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,metadata) VALUES
      ('pas','timeline-folder','test-node','timeline-agent',${sql.json([{type:"persistent_session",value:{enabled:true}}])}),
      ('pas-order','timeline-folder','test-node','timeline-agent',${sql.json([{type:"persistent_session",value:{enabled:true}}])})`;
    adapted = createBoardYjsSqlAdapter(sql as never);
    dbPort = { appendEventTx: async (tx: any, p: { sessionId: string; eventType: string; payload: string; searchableText: string; createdAt: Date; dedupeKey?: string | null }) => {
      const rows = await tx<{id:number}[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } };
  }, 90_000);

  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  const service = (append = appender) => new PersistentReportService(adapted, () => undefined, undefined, append);
  const cardService = (append = appender) => new CardControlPlaneService(
    adapted, dbPort, undefined, undefined, () => undefined, undefined, undefined, undefined, append,
  );
  const createConnectedCard = async (title: string) => {
    const sessionId = `pas-linked-${++connectedSessionNumber}`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,metadata) VALUES
      (${sessionId},'timeline-folder','test-node','timeline-agent',${sql.json([{type:"persistent_session",value:{enabled:true}}])})`;
    const cards = cardService();
    const cardId = (await cards.createCard({
      actorKind: "agent", actorSessionId: sessionId, actorUserId: null, folderId: "timeline-folder",
      title, request: "요청", assignee: { kind: "session", sessionId },
    })).operation.target_id;
    return { cardId, sessionId };
  };
  const timelineForCard = async (cardId: string) => await sql<{id:number;payload:Record<string,unknown>;searchable_text:string}[]>`
    SELECT id,payload,searchable_text FROM events WHERE event_type='report_timeline'
      AND payload->>'card_id'=${cardId} ORDER BY id`;

  it("records major card transitions and leaves situation-only updates out", async () => {
    const cards = cardService();
    const { cardId, sessionId } = await createConnectedCard("검수 카드");
    await cards.updateCardNow({ actorKind: "agent", actorSessionId: sessionId, cardId, now: "현재 글", turn: "user", ask: "검수해 주세요" });
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId, status: "review" });
    expect(await timelineForCard(cardId)).toMatchObject([{ payload: {
      type: "report_timeline", line_key: `card:${cardId}`, status: "review", title: "검수 카드",
      detail: "검수해 주세요", card_id: cardId,
    }, searchable_text: "" }]);
    const before = await timelineForCard(cardId);
    await cards.updateCardNow({ actorKind: "agent", actorSessionId: sessionId, cardId, now: "새 상황", turn: "user", ask: "상황만 변경" });
    expect(await timelineForCard(cardId)).toEqual(before);
  });

  it("records done without a board entry and omits stale detail", async () => {
    const cards = cardService();
    const { cardId } = await createConnectedCard("완료 카드");
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId, status: "done" });
    expect(await timelineForCard(cardId)).toMatchObject([{ payload: {
      type: "report_timeline", line_key: `card:${cardId}`, status: "done", title: "완료 카드", detail: "", card_id: cardId,
    } }]);
  });

  it("records new questions only and suppresses the blocked question transition", async () => {
    const cards = cardService();
    const reports = service();
    const { cardId, sessionId } = await createConnectedCard("질문 카드");
    await cards.askQuestion({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId, text: "어떻게 할까요?", options: ["진행"] });
    expect(await timelineForCard(cardId)).toEqual([]);
    const questionId = String((await cards.getCard(cardId))!.questions.at(-1)!.id);
    expect(await reports.putQuestion(sessionId, questionId)).toMatchObject({ ok: true, changed: true });
    expect(await timelineForCard(cardId)).toMatchObject([{ payload: {
      line_key: `card:${cardId}`, status: "question", title: "질문 카드", detail: "어떻게 할까요?", card_id: cardId,
    } }]);
    const before = await timelineForCard(cardId);
    await cards.answerQuestion({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId, questionId, answer: "진행" });
    expect(await timelineForCard(cardId)).toEqual(before);
  });

  it("records changed open PAS puts once and ignores answered entries", async () => {
    const reports = service();
    const ask = { key: "timeline-ask", kind: "ask", title: "확인", card_numbers: [], context: "질문 내용", action: "", options: ["네"] };
    expect(await reports.put("pas", ask)).toMatchObject({ ok: true, changed: true });
    expect(await reports.put("pas", ask)).toMatchObject({ ok: true, changed: false });
    expect(await reports.put("pas", { ...ask, state: "answered", answer: "네" })).toMatchObject({ ok: true, changed: true });
    const rows = await sql<{payload:Record<string,unknown>}[]>`SELECT payload FROM events WHERE session_id='pas' AND event_type='report_timeline' AND payload->>'line_key'='report:timeline-ask'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ status: "question", title: "확인", detail: "질문 내용", card_id: null, card_number: null });
  });

  it("does not create card timeline rows without a connected PAS", async () => {
    const cards = cardService();
    const result = await cards.createCard({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", folderId: "timeline-folder", title: "연결 없음", request: "요청" });
    await cards.setCardStatus({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId: result.operation.target_id, status: "review" });
    expect(await sql`SELECT 1 FROM events WHERE event_type='report_timeline' AND payload->>'card_id'=${result.operation.target_id}`).toHaveLength(0);
  });

  it("publishes preceding events in order before the new event", async () => {
    hub.publish.mockClear();
    const seed = async (type: string) => await sql<{id:number}[]>`SELECT event_append('pas-order',${type},${JSON.stringify({type})},'',NOW(),NULL) AS id`;
    const first = await seed("assistant_message");
    const second = await seed("complete");
    await appender("pas-order", line);
    const published = hub.publish.mock.calls.map(call => call[0].data.event._event_id);
    expect(published).toEqual([first[0]!.id, second[0]!.id, second[0]!.id + 1]);
    expect(hub.publish.mock.calls.at(-1)![0]).toMatchObject({ nodeId: "test-node", data: {
      type: "event", agentSessionId: "pas-order", event: { type: "report_timeline", line_key: line.line_key, _event_id: second[0]!.id + 1 },
    } });
  });

  it("leaves older events out of the replay so a past complete cannot fence live text", async () => {
    await sql`UPDATE events SET created_at = NOW() - INTERVAL '1 minute' WHERE session_id='pas-order'`;
    hub.publish.mockClear();
    await appender("pas-order", line);
    expect(hub.publish).toHaveBeenCalledTimes(1);
    expect(hub.publish.mock.calls[0]![0].data.event.type).toBe("report_timeline");
  });

  it("keeps card commits successful when timeline storage is unavailable", async () => {
    const brokenAppender = createReportTimelineAppender({
      resolveSql: async () => { throw new Error("DB unavailable"); },
      eventHub: hub as never,
      warn,
    });
    const cards = cardService(brokenAppender);
    const { cardId } = await createConnectedCard("실패 격리 카드");
    await expect(cards.setCardStatus({ actorKind: "user", actorSessionId: null, actorUserId: "director@example.com", cardId, status: "review" })).resolves.toBeDefined();
    expect((await cards.getCard(cardId))!.card.status).toBe("review");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("report_timeline"));
  });
});
