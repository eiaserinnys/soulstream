import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { waitForPostgres } from "./persistent-session-settings-world.js";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { serializeCardDetail } from "../src/cards/card_operations.js";
import { CardMcpReadService, type CardMcpGetInput } from "../src/cards/card_mcp_read.js";
import { PersistentReportService } from "../src/session/persistent_report_service.js";

// Same disposable production-schema fixture as card-question-rules.postgres.test.ts.
describe("card question storage and read contract", () => {
  let sql: ReturnType<typeof postgres>, stop: () => void;
  let cards: CardControlPlaneService;
  let reports: PersistentReportService;
  let reader: {
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "question_contract_test", password: "question_contract_test", database: "question_contract_test_db",
    });
    stop = container.stop;
    sql = postgres(`postgres://question_contract_test:question_contract_test@127.0.0.1:${container.port}/question_contract_test_db`, {
      max: 4, onnotice: () => {},
    });
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8"));
    expect(Number((await sql`SELECT COUNT(*) AS n FROM sessions`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES('contract-folder','질문 계약')`;
    const adapted = createFolderContentSqlAdapter(sql as never);
    cards = new CardControlPlaneService(adapted, { appendEventTx: async (tx, p) => {
      const rows = await tx<{ id: number }[]>`SELECT event_append(${p.sessionId},${p.eventType},${p.payload},${p.searchableText},${p.createdAt},${p.dedupeKey ?? null}) AS id`;
      return rows[0]!.id;
    } });
    reports = new PersistentReportService(adapted, () => {});
    reader = new CardMcpReadService(sql as never) as never;
  }, 90_000);

  beforeEach(async () => {
    await sql`DELETE FROM file_assets`;
    await sql`DELETE FROM folder_operations`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM sessions`;
    await sql`INSERT INTO sessions(session_id,folder_id,node_id,metadata) VALUES
      ('pas','contract-folder','node',${sql.json([{ type: "persistent_session", value: { enabled: true } }])}),
      ('author','contract-folder','node','[]')`;
  });
  afterAll(async () => { await sql?.end({ timeout: 2 }); stop?.(); });

  async function createCard(title: string): Promise<string> {
    const result = await cards.createCard({
      actorKind: "agent", actorSessionId: "pas", folderId: "contract-folder", title, request: "",
      assignee: { kind: "session", sessionId: "pas" },
    });
    return String(result.operation.target_id);
  }

  async function syncChanged(): Promise<boolean> {
    const result = await reports.syncBoard("pas");
    if (!result.ok) throw new Error(`board sync failed: ${JSON.stringify(result.errors)}`);
    return result.changed;
  }

  async function insertImageAsset(id: string, cardId: string): Promise<void> {
    await sql`INSERT INTO file_assets(
      id,storage_key,storage_purpose,storage_endpoint,storage_bucket,owner_kind,owner_key,
      registration_scope,source_session_id,original_name,mime_type,byte_size,upload_status
    ) VALUES (
      ${id},${"private/" + id},'attachment','https://r2.example.test','private-attachments','agent_session','pas',
      ${sql.json({ type: "card", id: cardId })}::jsonb,'pas',${id + ".png"},'image/png',8,'committed'
    )`;
  }

  it("reads a legacy-shaped question through REST detail, MCP get_card and the PAS board", async () => {
    const cardId = await createCard("카드 제목");
    await sql`INSERT INTO card_questions(id,card_id,session_id,text,options,asked_at)
      VALUES ('legacy-q',${cardId},'author','배경 글',${sql.json(["진행", "중단"])},'2026-01-03 00:00:00+00')`;

    const detail = serializeCardDetail((await cards.getCard(cardId))!);
    const rest = detail.questions.find((row) => row.id === "legacy-q")!;
    expect(rest).toMatchObject({
      title: null, options: ["진행", "중단"], kind: "choice", revision: 1, selectedOption: null, revisedAt: null,
      optionDetails: [{ label: "진행" }, { label: "중단" }], attachments: [],
    });

    const first = await reader.getCard(cardId, { include: ["questions_history"] }, null);
    expect(first.questions.items[0]).toMatchObject({
      id: "legacy-q", options: ["진행", "중단"], kind: "choice", revision: 1, selectedOption: null,
      optionDetails: [{ label: "진행" }, { label: "중단" }], attachments: [],
    });
    expect(first.sections.questions_history.items[0]).toMatchObject({ id: "legacy-q", title: null, kind: "choice", revision: 1 });

    expect(await reports.putQuestion("pas", "legacy-q")).toMatchObject({ ok: true });
    const entry = (await reports.get("pas")).find(candidate => candidate.key === "cq_legacy-q")!;
    expect(entry).toMatchObject({
      title: "카드 제목", context: "배경 글", options: ["진행", "중단"],
      question_text: "배경 글", question_kind: "choice", question_revision: 1,
      question_option_details: [{ label: "진행" }, { label: "중단" }],
      question_attachments: [], question_revised_at: null,
    });
    expect(entry.question_title).toBeUndefined();
  });

  it("projects a new-shape question with option details and attachments on every read path", async () => {
    const cardId = await createCard("새 꼴 카드");
    await insertImageAsset("asset-1", cardId);
    const options = [
      { label: "진행", description: "바로 실행합니다", recommended: true },
      { label: "중단", description: "멈춥니다" },
    ];
    const attachments = [
      { type: "image", label: "시안", attachment_id: "asset-1" },
      { type: "link", label: "참고", url: "https://example.test/ref" },
    ];
    await sql`INSERT INTO card_questions(id,card_id,session_id,text,options,title,kind,attachments,revision,revised_at,asked_at)
      VALUES ('new-q',${cardId},'author','배경 전문',${sql.json(options)},'고를 것','choice',${sql.json(attachments)},2,
        '2099-01-01 00:00:00+00','2026-01-03 00:00:00+00')`;

    const detail = serializeCardDetail((await cards.getCard(cardId))!);
    const rest = detail.questions.find((row) => row.id === "new-q")!;
    expect(rest).toMatchObject({
      title: "고를 것", kind: "choice", revision: 2, options: ["진행", "중단"],
      optionDetails: options, selectedOption: null, revisedAt: "2099-01-01T00:00:00.000Z",
    });
    const restAttachments = rest.attachments as Record<string, unknown>[];
    expect(restAttachments[0]).toMatchObject({
      type: "image", label: "시안", attachment_id: "asset-1",
      read_context: { type: "card", id: cardId },
      descriptor: { attachment_id: "asset-1", mime_type: "image/png", preview_kind: "image" },
    });
    expect(String(restAttachments[0]!.url)).toContain(`/api/attachments/asset-1/content?context_type=card&context_id=${cardId}`);
    expect(restAttachments[0]).not.toHaveProperty("availability");
    expect(restAttachments[1]).toEqual({ type: "link", label: "참고", url: "https://example.test/ref" });

    const mcp = await reader.getCard(cardId, { include: ["questions_history"] }, null);
    expect(mcp.questions.items[0]).toMatchObject({
      title: "고를 것", kind: "choice", revision: 2, options: ["진행", "중단"], optionDetails: options,
    });
    expect(mcp.questions.items[0].attachments[0]).toMatchObject({
      type: "image", label: "시안", attachment_id: "asset-1", read_context: { type: "card", id: cardId },
    });
    expect(mcp.sections.questions_history.items[0]).toMatchObject({ id: "new-q", revision: 2, kind: "choice" });

    await reports.putQuestion("pas", "new-q");
    const entry = (await reports.get("pas")).find(candidate => candidate.key === "cq_new-q")!;
    expect(entry).toMatchObject({
      title: "고를 것", question_title: "고를 것", question_text: "배경 전문", question_kind: "choice",
      question_option_details: options, question_revision: 2,
      question_revised_at: "2099-01-01T00:00:00.000Z", updated_at: "2099-01-01T00:00:00.000Z",
    });
    expect(entry.question_attachments?.[0]).toMatchObject({
      type: "image", label: "시안", attachment_id: "asset-1", read_context: { type: "card", id: cardId },
    });
    expect(entry.question_attachments?.[1]).toEqual({ type: "link", label: "참고", url: "https://example.test/ref" });
  });

  it("exposes comment question_id and fingerprints it for since reads", async () => {
    const cardId = await createCard("글타래 카드");
    await sql`INSERT INTO card_questions(id,card_id,text,asked_at)
      VALUES ('thread-q',${cardId},'질문','2026-01-03 00:00:00+00')`;
    await sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body)
      VALUES ('thread-c',${cardId},'agent','comment','되묻는 글')`;

    const detail = serializeCardDetail((await cards.getCard(cardId))!);
    expect(detail.comments.find(row => row.id === "thread-c")).toMatchObject({ questionId: null });

    const first = await reader.getCard(cardId, { include: ["comments"] }, null);
    expect(first.sections.comments.items[0]).toMatchObject({ id: "thread-c", questionId: null });

    await sql`UPDATE card_comments SET question_id='thread-q' WHERE id='thread-c'`;
    const second = await reader.getCard(cardId, { since: first.changeToken, include: ["comments"] }, null);
    expect(second.changed).toContain("comments");
    expect(second.sections.comments.items[0]).toMatchObject({ id: "thread-c", questionId: "thread-q" });
    expect(serializeCardDetail((await cards.getCard(cardId))!).comments.find(row => row.id === "thread-c"))
      .toMatchObject({ questionId: "thread-q" });
  });

  it("reports a change when only new question columns change", async () => {
    const cardId = await createCard("수정 카드");
    await sql`INSERT INTO card_questions(id,card_id,text,options,title,kind,revision,asked_at)
      VALUES ('revise-q',${cardId},'배경',${sql.json([{ label: "진행", description: "처음" }])},'고칠 것','choice',1,
        '2026-01-03 00:00:00+00')`;

    const first = await reader.getCard(cardId, { include: ["questions_history"] }, null);
    expect(first.questions.items[0]).toMatchObject({ id: "revise-q", revision: 1, optionDetails: [{ label: "진행", description: "처음" }] });

    await sql`UPDATE card_questions SET revision=2, revised_at='2026-02-01 00:00:00+00' WHERE id='revise-q'`;
    const second = await reader.getCard(cardId, { since: first.changeToken, include: ["questions_history"] }, null);
    expect(second.unchanged).toBe(false);
    expect(second.changed).toEqual(expect.arrayContaining(["questions", "questions_history"]));
    expect(second.questions).toMatchObject({
      replace: true,
      items: [{ id: "revise-q", revision: 2, revisedAt: "2026-02-01T00:00:00.000Z" }],
    });
    expect(second.sections.questions_history.items[0]).toMatchObject({ id: "revise-q", revision: 2 });
  });

  it("republishes the PAS board when only question details change and stays quiet afterwards", async () => {
    const cardId = await createCard("판 갱신");
    await sql`INSERT INTO card_questions(id,card_id,session_id,text,options,title,kind,revision,asked_at)
      VALUES ('board-q',${cardId},'author','배경',${sql.json([{ label: "진행", description: "처음" }])},'고를 것','choice',1,
        '2026-01-03 00:00:00+00')`;

    await reports.putQuestion("pas", "board-q");
    expect((await reports.get("pas")).find(candidate => candidate.key === "cq_board-q"))
      .toMatchObject({ question_revision: 1, title: "고를 것" });

    await sql`UPDATE card_questions SET revision=2, revised_at='2026-02-01 00:00:00+00' WHERE id='board-q'`;
    expect(await syncChanged()).toBe(true);
    expect((await reports.get("pas")).find(candidate => candidate.key === "cq_board-q")).toMatchObject({
      question_revision: 2, question_revised_at: "2026-02-01T00:00:00.000Z",
    });
    expect(await syncChanged()).toBe(false);

    await sql`UPDATE card_questions SET options=${sql.json([{ label: "진행", description: "바뀐 설명" }])} WHERE id='board-q'`;
    expect(await syncChanged()).toBe(true);
    expect((await reports.get("pas")).find(candidate => candidate.key === "cq_board-q"))
      .toMatchObject({ question_option_details: [{ label: "진행", description: "바뀐 설명" }] });
    expect(await syncChanged()).toBe(false);
  });
});
