import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { cardOperationSchemas } from "../src/cards/card_operations.js";

// 완료 결과 보고를 카드 커멘트로 남기는 경로. 확인 항목이 있는 카드에서 사용자 글 없이도
// 담당이 request_card_review/set_card_status(done)의 report로 보고를 남길 수 있어야 한다.
describe("card completion reports as comments", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let sequence = 0;
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director@example.com" };
  const owner = { actorKind: "agent" as const, actorSessionId: "owner" };
  const key = () => `report-test:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN model_preset TEXT, ADD COLUMN metadata JSONB`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('report-folder','보고')`;
    const sql = createFolderContentSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, {
      appendEventTx: async (tx, p) => {
        const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
        return rows[0]!.id;
      },
    }, { emitCardUpdated: async () => {}, emitFolderUpdated: async () => {} });
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  async function makeAssignedCard(title = "보고 대상", items = false) {
    const created = await cards.createCard({ ...human, folderId: "report-folder", title, request: "요청", idempotencyKey: key() });
    const cardId = created.operation.target_id;
    await h.sql`UPDATE cards SET status='running',assignee_kind='session',assignee_session_id='owner' WHERE id=${cardId}`;
    if (items) await cards.setCardItems({ ...owner, cardId, items: ["첫 결과", "둘째 결과"], idempotencyKey: key() });
    return cardId;
  }

  function agentComments(cardId: string) {
    return cards.getCard(cardId).then(detail => detail!.comments.filter(comment =>
      comment.author_kind === "agent" && comment.kind === "comment"));
  }

  it("records the review report as one agent comment without user input", async () => {
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running') ON CONFLICT (session_id) DO NOTHING`;
    for (const [label, items] of [["확인 항목 없음", false], ["확인 항목 있음", true]] as const) {
      const cardId = await makeAssignedCard(`검수 보고 ${label}`, items);
      await cards.requestCardReview({ ...owner, cardId, ask: "결과를 확인해 주세요",
        report: "  요점 한 줄\n둘째 줄  ", idempotencyKey: key() });
      const detail = (await cards.getCard(cardId))!;
      expect(detail.card.status).toBe("review");
      const comments = await agentComments(cardId);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ author_kind: "agent", author_id: null, session_id: "owner",
        kind: "comment", body: "요점 한 줄\n둘째 줄", item_id: null, question_id: null });
    }
  });

  it("records the done report and keeps report-less calls comment-free", async () => {
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running') ON CONFLICT (session_id) DO NOTHING`;
    const plain = await makeAssignedCard("보고 없는 완료");
    await cards.requestCardReview({ ...owner, cardId: plain, ask: "확인해 주세요", idempotencyKey: key() });
    expect(await agentComments(plain)).toHaveLength(0);

    const cardId = await makeAssignedCard("완료 보고");
    await cards.setCardStatus({ ...owner, cardId, status: "done", report: "전부 끝났습니다", idempotencyKey: key() });
    expect((await cards.getCard(cardId))!.card.status).toBe("done");
    const comments = await agentComments(cardId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author_kind: "agent", kind: "comment", body: "전부 끝났습니다" });
  });

  it("rejects empty and over-long reports before changing the card", async () => {
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running') ON CONFLICT (session_id) DO NOTHING`;
    const cardId = await makeAssignedCard("잘못된 보고");
    const version = (await cards.getCard(cardId))!.card.version;
    await expect(cards.requestCardReview({ ...owner, cardId, ask: "확인해 주세요", report: "   \n ", idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, message: "report를 비워 둘 수 없습니다" });
    await expect(cards.requestCardReview({ ...owner, cardId, ask: "확인해 주세요", report: "가".repeat(2001), idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, message: "report는 2000자까지입니다. 지금 2001자로 1자 넘습니다. 결과 보고는 300~800자가 보통이니 파일, 커밋, 시험 수 같은 세부는 add_card_note로 옮기고 800자 안팎으로 다시 쓰세요" });
    const detail = (await cards.getCard(cardId))!;
    expect(detail.card).toMatchObject({ status: "running", version });
    expect(await agentComments(cardId)).toHaveLength(0);

    const parsed = cardOperationSchemas.set_card_status.safeParse({ cardId: "card-1", expectedVersion: 1,
      idempotencyKey: "status-1", status: "running", report: "보고" });
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })))
      .toContainEqual({ path: ["report"], message: "결과 보고는 완료(done)로 옮길 때만 받습니다" });
    expect(cardOperationSchemas.set_card_status.safeParse({ cardId: "card-1", expectedVersion: 1,
      idempotencyKey: "status-2", status: "done", report: "보고" }).success).toBe(true);
  });

  it("rejects a report from a supervisor that is not the assignee", async () => {
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running') ON CONFLICT (session_id) DO NOTHING`;
    await h.sql`INSERT INTO sessions(session_id,status,session_type,metadata) VALUES ('pas','running',NULL,${h.sql.json([{ type: "persistent_session", value: { enabled: true } }])}) ON CONFLICT (session_id) DO NOTHING`;
    const cardId = await makeAssignedCard("감독 보고");
    await h.sql`UPDATE cards SET status='review',created_session_id='pas' WHERE id=${cardId}`;
    const version = (await cards.getCard(cardId))!.card.version;
    await expect(cards.setCardStatus({ actorKind: "agent", actorSessionId: "pas", cardId, status: "done",
      report: "감독이 대신 보고", idempotencyKey: key() }))
      .rejects.toMatchObject({ statusCode: 422, message: "결과 보고는 카드 담당 세션만 남깁니다" });
    const detail = (await cards.getCard(cardId))!;
    expect(detail.card).toMatchObject({ status: "review", version });
    expect(await agentComments(cardId)).toHaveLength(0);
  });

  it("keeps one report comment when the same idempotency key is retried", async () => {
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running') ON CONFLICT (session_id) DO NOTHING`;
    const cardId = await makeAssignedCard("재시도 보고", true);
    const input = { ...owner, cardId, ask: "확인해 주세요", report: "한 번만 남아야 합니다", idempotencyKey: key() };
    await cards.requestCardReview(input);
    await cards.requestCardReview(input);
    expect(await agentComments(cardId)).toHaveLength(1);

    const doneId = await makeAssignedCard("재시도 완료 보고");
    const done = { ...owner, cardId: doneId, status: "done" as const, report: "완료 보고", idempotencyKey: key() };
    await cards.setCardStatus(done);
    await cards.setCardStatus(done);
    expect(await agentComments(doneId)).toHaveLength(1);
  });
});
