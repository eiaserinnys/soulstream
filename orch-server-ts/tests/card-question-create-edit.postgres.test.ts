import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { serializeCardDetail } from "../src/cards/card_operations.js";
import { CardMcpReadService, type CardMcpGetInput } from "../src/cards/card_mcp_read.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";

// Same disposable production-schema fixture as card-question-read-contract.postgres.test.ts.
describe("card question creation and in-place edit", () => {
  let sql: ReturnType<typeof postgres>, stop: () => void;
  let cards: CardControlPlaneService;
  let reports: PersistentReportService;
  let reader: {
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };
  const human = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const asked = vi.fn(async (_input: { cardId: string; questionId: string }) => {});
  const timeline = vi.fn(async () => {});

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "question_edit_test", password: "question_edit_test", database: "question_edit_test_db",
    });
    stop = container.stop;
    sql = postgres(`postgres://question_edit_test:question_edit_test@127.0.0.1:${container.port}/question_edit_test_db`, {
      max: 4, onnotice: () => {},
    });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES('edit-folder','질문 고침')`;
    const adapted = createFolderContentSqlAdapter(sql as never);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx, p) => {
      const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } }, undefined, undefined, () => {}, () => {}, [], asked, timeline);
    reports = new PersistentReportService(adapted, () => {});
    reader = new CardMcpReadService(sql as never) as never;
  }, 90_000);

  beforeEach(async () => {
    await sql`DELETE FROM file_assets`;
    await sql`DELETE FROM folder_operations`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM sessions`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,agent_id,status,metadata) VALUES
      ('pas','edit-folder','node','supervisor','running',${sql.json([{ type: "persistent_session", value: { enabled: true } }])}),
      ('worker','edit-folder','node','worker','running','[]'),
      ('worker-2','edit-folder','node','worker','running','[]')`;
    asked.mockClear();
    timeline.mockClear();
  });
  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  async function createCard(title: string, sessionId = "worker"): Promise<string> {
    const result = await cards.createCard({
      actorKind: "agent", actorSessionId: "pas", folderId: "edit-folder", title, request: "",
      assignee: { kind: "session", sessionId },
    });
    return String(result.operation.target_id);
  }

  async function insertImageAsset(id: string, cardId: string, owner = "worker"): Promise<void> {
    await sql`INSERT INTO file_assets(
      id,storage_key,storage_purpose,storage_endpoint,storage_bucket,owner_kind,owner_key,
      registration_scope,source_session_id,original_name,mime_type,byte_size,upload_status
    ) VALUES (
      ${id},${"private/" + id},'attachment','https://r2.example.test','private-attachments','agent_session',${owner},
      ${sql.json({ type: "card", id: cardId })}::jsonb,${owner},${id + ".png"},'image/png',8,'committed'
    )`;
  }

  function ask(body: Record<string, unknown>, sessionId = "worker") {
    return cards.askQuestion({
      actorKind: "agent", actorSessionId: sessionId, cardId: String(body.cardId), ...body,
    } as never);
  }

  function boardEntry(questionId: string) {
    return reports.get("pas").then(entries => entries.find(entry => entry.key === `cq_${questionId}`));
  }

  it("stores a new-shape choice as one row and projects it to REST, MCP and the PAS board", async () => {
    const cardId = await createCard("결정 카드");
    await insertImageAsset("asset-1", cardId, "worker");
    const options = [
      { label: "진행", description: "바로 실행합니다", recommended: true },
      { label: "중단", description: "멈춥니다" },
    ];
    const attachments = [
      { type: "image", label: "시안", attachment_id: "asset-1" },
      { type: "link", label: "참고", url: "https://example.test/ref" },
    ];
    await ask({ cardId, title: "고를 것", text: "배경 전문", kind: "choice", options, attachments });

    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId}`;
    expect(rows).toHaveLength(1);
    const questionId = String(rows[0]!.id);
    expect(rows[0]).toMatchObject({ title: "고를 것", kind: "choice", revision: 1, revised_at: null });
    expect(rows[0]!.options).toEqual(options);
    expect(rows[0]!.attachments).toEqual(attachments);
    expect(String(rows[0]!.session_id)).toBe("worker");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith({ cardId, questionId });

    const cardRow = (await sql<{ attachment_refs: unknown }[]>`SELECT attachment_refs FROM cards WHERE id=${cardId}`)[0]!;
    expect(cardRow.attachment_refs).toEqual([{ attachment_id: "asset-1" }]);

    const detail = serializeCardDetail((await cards.getCard(cardId))!);
    const rest = detail.questions.find(row => row.id === questionId)!;
    expect(rest).toMatchObject({
      title: "고를 것", kind: "choice", revision: 1, options: ["진행", "중단"], optionDetails: options,
      selectedOption: null, revisedAt: null,
    });
    const restAttachments = rest.attachments as Record<string, unknown>[];
    expect(restAttachments[0]).toMatchObject({
      type: "image", label: "시안", attachment_id: "asset-1", read_context: { type: "card", id: cardId },
    });
    expect(String(restAttachments[0]!.url)).toContain(`/api/attachments/asset-1/content?context_type=card&context_id=${cardId}`);
    expect(restAttachments[1]).toEqual({ type: "link", label: "참고", url: "https://example.test/ref" });

    const mcp = await reader.getCard(cardId, { include: ["questions_history"] }, null);
    expect(mcp.questions.items[0]).toMatchObject({
      id: questionId, title: "고를 것", kind: "choice", revision: 1, options: ["진행", "중단"], optionDetails: options,
    });
    expect(mcp.sections.questions_history.items[0]).toMatchObject({ id: questionId, revision: 1, kind: "choice" });

    const entry = (await boardEntry(questionId))!;
    expect(entry).toMatchObject({
      title: "고를 것", question_title: "고를 것", question_text: "배경 전문", question_kind: "choice",
      question_option_details: options, question_revision: 1, question_revised_at: null,
    });
    expect(entry.question_attachments?.[0]).toMatchObject({
      type: "image", label: "시안", attachment_id: "asset-1", read_context: { type: "card", id: cardId },
    });
    expect(entry.question_attachments?.[1]).toEqual({ type: "link", label: "참고", url: "https://example.test/ref" });
    expect(await reports.acceptReply("pas", [{ key: "persistent_report_reply", content: { key: `cq_${questionId}`, option: "진행" } }], { source: "browser" }))
      .toEqual({ action: "card", cardId, questionId, option: "진행" });
  });

  it("stores a request with the single 했어 option and stores the legacy shape as before", async () => {
    const cardId = await createCard("부탁 카드");
    await ask({ cardId, title: "배포 확인", text: "스테이징에서 직접 확인해 주세요", kind: "request" });
    await expect(ask({ cardId, title: "옵션 있는 부탁", text: "안 됨", kind: "request", options: [] }))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST" });
    await cards.askQuestion({ ...human, cardId, text: "옛 꼴 질문", options: ["진행", "중단"] });

    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId} ORDER BY asked_at, id`;
    expect(rows).toHaveLength(2);
    const request = rows.find(row => row.kind === "request")!;
    expect(request).toMatchObject({ title: "배포 확인", kind: "request", revision: 1, revised_at: null });
    expect(request.options).toEqual([{ label: "했어" }]);
    const legacy = rows.find(row => row.kind === "choice")!;
    expect(legacy).toMatchObject({ title: null, kind: "choice", revision: 1, revised_at: null, session_id: null });
    expect(legacy.options).toEqual(["진행", "중단"]);
    expect(legacy.attachments).toEqual([]);
  });

  it("edits an open question in place and republishes the same board entry without a new-question signal", async () => {
    const cardId = await createCard("고침 카드");
    await insertImageAsset("asset-1", cardId, "worker");
    await ask({
      cardId, title: "처음 제목", text: "처음 배경", kind: "choice",
      options: [{ label: "진행", description: "처음 설명", recommended: true }],
      attachments: [{ type: "image", label: "시안", attachment_id: "asset-1" }],
    });
    const [created] = await sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId}`;
    const questionId = String(created!.id);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(await boardEntry(questionId)).toMatchObject({
      question_revision: 1, question_text: "처음 배경", question_option_details: [{ label: "진행", description: "처음 설명", recommended: true }],
    });
    const cardBefore = (await cards.getCard(cardId))!.card;
    const first = await reader.getCard(cardId, { include: ["questions_history"] }, null);
    asked.mockClear();

    const options = [
      { label: "진행", description: "바뀐 설명", recommended: true },
      { label: "보류", description: "나중에 합니다" },
    ];
    const attachments = [
      { type: "image", label: "시안", attachment_id: "asset-1" },
      { type: "link", label: "참고", url: "https://example.test/ref" },
    ];
    await ask({ cardId, questionId, title: "고친 제목", text: "고친 배경", kind: "choice", options, attachments });

    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM card_questions WHERE card_id=${cardId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created!.id, session_id: created!.session_id, asked_at: created!.asked_at });
    expect(rows[0]).toMatchObject({ title: "고친 제목", kind: "choice", revision: 2 });
    expect(rows[0]!.text).toBe("고친 배경");
    expect(rows[0]!.options).toEqual(options);
    expect(rows[0]!.attachments).toEqual(attachments);
    expect(rows[0]!.revised_at).not.toBeNull();
    expect(asked).not.toHaveBeenCalled();
    expect(timeline).not.toHaveBeenCalled();

    const cardAfter = (await cards.getCard(cardId))!.card;
    expect(cardAfter).toMatchObject({
      status: cardBefore.status, blocked_kind: cardBefore.blocked_kind,
      assignee_session_id: cardBefore.assignee_session_id, version: cardBefore.version,
    });

    const published = (await reports.get("pas")).filter(entry => entry.key === `cq_${questionId}`);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      title: "고친 제목", question_title: "고친 제목", question_text: "고친 배경", question_kind: "choice",
      question_option_details: options, question_revision: 2, question_revised_at: expect.any(String),
    });
    expect(published[0]!.question_attachments?.[1]).toEqual({ type: "link", label: "참고", url: "https://example.test/ref" });

    const second = await reader.getCard(cardId, {
      since: first.changeToken, include: ["questions_history"],
    }, null);
    expect(second.changed).toEqual(expect.arrayContaining(["questions", "questions_history"]));
    expect(second.questions).toMatchObject({
      replace: true,
      items: [{ id: questionId, title: "고친 제목", revision: 2, options: ["진행", "보류"] }],
    });
    expect(second.sections.questions_history.items[0]).toMatchObject({ id: questionId, revision: 2 });

    await ask({
      cardId, questionId, title: "고친 제목", text: "고친 배경", kind: "choice",
      options: [{ label: "진행", description: "설명만 다시" }, { label: "보류", description: "나중에 합니다" }],
      attachments,
    });
    const republished = await boardEntry(questionId);
    expect(republished).toMatchObject({
      question_option_details: [{ label: "진행", description: "설명만 다시" }, { label: "보류", description: "나중에 합니다" }],
      question_revision: 3,
    });
    expect(Number((await sql<{ n: number }[]>`SELECT COUNT(*) AS n FROM card_questions WHERE card_id=${cardId}`)[0]!.n)).toBe(1);
  });

  it("rejects an in-place edit of an answered, withdrawn or unknown question", async () => {
    const cardId = await createCard("답한 카드");
    await ask({ cardId, title: "답할 것", text: "배경", kind: "choice", options: [{ label: "진행", description: "갑니다" }] });
    const questionId = String((await sql<{ id: string }[]>`SELECT id FROM card_questions WHERE card_id=${cardId}`)[0]!.id);
    await cards.answerQuestion({ ...human, cardId, questionId, answer: "진행" });
    const edit = { cardId, questionId, title: "고칠 것", text: "고친 배경", kind: "choice", options: [{ label: "진행", description: "갑니다" }] };
    await expect(ask(edit)).rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message: "이미 답한 질문은 고칠 수 없습니다" });

    const withdrawnCardId = await createCard("철회한 카드", "worker-2");
    await ask({ cardId: withdrawnCardId, title: "철회할 것", text: "배경", kind: "choice", options: ["진행"] }, "worker-2");
    const withdrawnId = String((await sql<{ id: string }[]>`SELECT id FROM card_questions WHERE card_id=${withdrawnCardId}`)[0]!.id);
    await cards.withdrawQuestion({ actorKind: "agent", actorSessionId: "worker-2", cardId: withdrawnCardId, questionId: withdrawnId, reason: "대화로 정리" });
    await expect(ask({ ...edit, cardId: withdrawnCardId, questionId: withdrawnId }, "worker-2"))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message: "철회된 질문은 고칠 수 없습니다" });

    await expect(ask({ ...edit, questionId: "no-such-question" }))
      .rejects.toMatchObject({ statusCode: 422, code: "INVALID_CARD_REQUEST", message: expect.stringContaining("찾을 수 없습니다") });
  });

  it("links a committed card-scoped image to the question and refuses a wrong-scope attachment", async () => {
    const cardId = await createCard("첨부 카드");
    await insertImageAsset("asset-1", cardId, "worker");
    await ask({
      cardId, title: "시안 결정", text: "어느 시안으로 갈까요?", kind: "choice",
      options: [{ label: "A안", description: "첫 시안" }],
      attachments: [{ type: "image", label: "시안", attachment_id: "asset-1" }],
    });
    const question = (await cards.getCard(cardId))!.questions[0]!;
    const detail = serializeCardDetail((await cards.getCard(cardId))!);
    const attachments = detail.questions.find(row => row.id === question.id)!.attachments as Record<string, unknown>[];
    const attachment = attachments[0]!;
    expect(attachment).toMatchObject({ attachment_id: "asset-1", read_context: { type: "card", id: cardId } });
    expect(String(attachment.url)).toContain(`/api/attachments/asset-1/content?context_type=card&context_id=${cardId}`);

    const otherCardId = await createCard("다른 카드", "worker-2");
    await insertImageAsset("asset-other", otherCardId, "worker");
    await expect(ask({
      cardId, title: "남의 첨부", text: "다른 카드 첨부", kind: "choice",
      options: [{ label: "진행", description: "갑니다" }],
      attachments: [{ type: "image", label: "남의 시안", attachment_id: "asset-other" }],
    })).rejects.toMatchObject({ statusCode: 403, code: "ATTACHMENT_CARD_SCOPE_DENIED" });
    await expect(ask({
      cardId, title: "긴 이름", text: "첨부 이름은 증거와 같은 검사를 지난다", kind: "choice",
      options: [{ label: "진행", description: "갑니다" }],
      attachments: [{ type: "image", label: "가".repeat(41), attachment_id: "asset-1" }],
    })).rejects.toMatchObject({ statusCode: 422 });
    expect(Number((await sql<{ n: number }[]>`SELECT COUNT(*) AS n FROM card_questions WHERE card_id=${cardId}`)[0]!.n)).toBe(1);
  });
});
