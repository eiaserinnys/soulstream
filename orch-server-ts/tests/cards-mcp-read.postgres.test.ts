import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardMcpReadService, type CardMcpGetInput } from "../src/cards/card_mcp_read.js";
import { CardMcpReadRepository } from "../src/cards/control_plane/card_mcp_read_repository.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { CardItem } from "../src/cards/card_item_rules.js";
import type { CardNow } from "../src/cards/card_item_rules.js";

type SeedCard = {
  id: string;
  folderId?: string;
  number?: number | null;
  title?: string;
  request?: string;
  brief?: string;
  attachments?: CardAttachment[];
  items?: CardItem[];
  now?: CardNow | null;
  status?: string;
  archived?: boolean;
  version?: number;
  blockedKind?: string | null;
  blockedDetail?: string | null;
};

describe("Card MCP read storage contract", () => {
  let h: PagePostgresHarness;
  let reader: {
    listCards: CardMcpReadService["listCards"];
    getCard: (cardId: string, input: CardMcpGetInput, allowedFolderIds: readonly string[] | null) => Promise<Record<string, any>>;
  };

  async function seedCard(input: SeedCard): Promise<void> {
    await h.sql`
      INSERT INTO cards(id,number,folder_id,position_key,title,request,brief,attachments,items,now,status,archived,version,blocked_kind,blocked_detail)
      VALUES (
        ${input.id},${input.number === undefined ? null : input.number},${input.folderId ?? "pas-a"},${input.id},
        ${input.title ?? input.id},${input.request ?? ""},${input.brief ?? ""},${h.sql.json(JSON.parse(JSON.stringify(input.attachments ?? [])))},
        ${h.sql.json(input.items ?? [])},${h.sql.json(input.now ?? null)},${input.status ?? "todo"},
        ${input.archived ?? false},${input.version ?? 1},${input.blockedKind ?? null},${input.blockedDetail ?? null}
      )
    `;
  }

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    reader = new CardMcpReadService(createBoardYjsSqlAdapter(h.liveSql)) as unknown as typeof reader;
    await h.sql.unsafe(
      "INSERT INTO folders(id,name) VALUES ('pas-a','PAS A'),('pas-b','PAS B'),('list-only','List only'),('claude','system'),('llm','system')",
    );
    await h.sql.unsafe(
      "INSERT INTO sessions(session_id,folder_id,display_name,node_id,agent_id,status,created_at,updated_at) " +
      "VALUES ('read-session-a','pas-a','세션 A','eiaserinnys','seosoyoung-pas','running','2026-10-08 06:00:00.000001+00','2026-10-08 06:00:00.000001+00')," +
      "('read-session-b','pas-a','세션 B','eiaserinnys','seosoyoung-pas','completed','2026-10-08 06:00:00.000002+00','2026-10-08 06:00:00.000002+00')",
    );
  }, 60_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("returns a small current DTO while preserving item evidence and unanswered questions", async () => {
    const item: CardItem = {
      id: 1,
      title: "저장 결과",
      state: "done",
      result: "확인된 결과",
      evidence: [{ type: "link", url: "https://example.test/evidence", label: "근거" }],
      caveat: "남은 한계",
      rev: 3,
      confirmed: null,
      fixOpen: 0,
      reopened: "보완 후 재보고",
      from: null,
      createdAt: "2026-10-08T06:00:00.000Z",
      reportedAt: "2026-10-08T06:01:00.000Z",
    };
    await seedCard({
      id: "read-summary",
      number: 238,
      title: "PAS 조회",
      request: "요청 원문",
      brief: "인계 원문",
      attachments: [{ nodeId: "eiaserinnys", path: "/incoming/upload/read-summary.txt", name: "기록", mimeType: "text/plain" }],
      items: [item],
      now: { text: "현재 확인 중", turn: "agent", ask: null, updatedAt: "2026-10-08T06:02:00.000Z", sessionId: "read-session-a" },
      status: "blocked",
      version: 7,
      blockedKind: "question",
      blockedDetail: "결정 대기",
    });
    await h.sql.unsafe(
      "UPDATE sessions SET card_id='read-summary' WHERE session_id='read-session-a'",
    );
    await h.sql.unsafe(
      "INSERT INTO card_questions(id,card_id,session_id,text,options,answer,asked_at,answered_at) VALUES " +
      "('summary-q-old','read-summary','read-session-a','옛 미답',NULL,NULL,'2026-10-08 06:00:00.000001+00',NULL)," +
      "('summary-q-new','read-summary','read-session-a','최근 미답',NULL,NULL,'2026-10-08 06:00:00.000009+00',NULL)," +
      "('summary-q-answered','read-summary','read-session-a','답변 완료','[]','예','2026-10-08 06:00:00.000010+00','2026-10-08 06:00:00.000011+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES " +
      "('summary-comment','read-summary','agent','comment','공개 댓글','2026-10-08 06:00:00.000001+00')," +
      "('summary-note','read-summary','agent','note','비공개 노트','2026-10-08 06:00:00.000002+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO card_reports(id,card_id,title,format,body,created_at) VALUES " +
      "('summary-report','read-summary','보고','markdown','보고 본문','2026-10-08 06:00:00.000003+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,payload_json,created_at) " +
      "VALUES ('summary-now','pas-a','card','read-summary','update_card_now',jsonb_build_object('text','이전 상황','turn','agent','ask',NULL),'2026-10-08 06:00:00.000004+00')",
    );

    const result = await reader.getCard("read-summary", {}, null);
    expect(Object.keys(result.card).sort()).toEqual([
      "archived", "assigneeAgentId", "assigneeKind", "assigneeSessionId", "assigneeUserId", "blockedDetail",
      "blockedKind", "folderId", "id", "items", "now", "number", "status", "title", "version",
    ]);
    expect(result.card).toMatchObject({ id: "read-summary", number: 238, folderId: "pas-a", blockedDetail: "결정 대기" });
    expect(result.card.items[0]).toMatchObject({
      id: 1,
      rev: 3,
      result: "확인된 결과",
      evidence: [{ type: "link", url: "https://example.test/evidence", label: "근거" }],
      caveat: "남은 한계",
      reopened: "보완 후 재보고",
      display: "changed",
    });
    expect(result.questions.items.map((question: { text: string }) => question.text)).toEqual(["최근 미답", "옛 미답"]);
    expect(result.questions).toMatchObject({ nextCursor: null, truncated: false });
    const questionPage = await reader.getCard("read-summary", { limit: 1 }, null);
    const nextQuestionPage = await reader.getCard("read-summary", {
      limit: 1, cursors: { questions: questionPage.questions.nextCursor },
    }, null);
    expect(nextQuestionPage.questions.items).toMatchObject([{ text: "옛 미답" }]);
    expect(nextQuestionPage.questions).toMatchObject({ nextCursor: null, truncated: false });
    expect(result.available).toEqual({
      request: true, brief: true, attachments: true, comments: 1, notes: 1, reports: 1, sessions: 1, now_history: 1,
    });
    expect(result.changeToken).toEqual(expect.any(String));
    for (const key of ["request", "brief", "attachments", "comments", "notes", "reports", "sessions", "nowHistory", "latestActivity"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("paginates Unicode text and every selected record collection without losing source bodies", async () => {
    await seedCard({
      id: "read-pages",
      request: "한글😀원문전체",
      brief: "인계😀본문",
      attachments: [
        { nodeId: "eiaserinnys", path: "/incoming/upload/first.txt", name: "첫 첨부", mimeType: "text/plain" },
        { nodeId: "eiaserinnys", path: "/incoming/upload/second.txt", name: "둘 첨부", mimeType: "text/plain" },
      ],
    });
    await h.sql.unsafe(
      "INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES " +
      "('pages-comment-old','read-pages','user','comment','댓글 이전','2026-10-08 06:00:00.123455+00')," +
      "('pages-comment-new','read-pages','user','comment','댓글 최신','2026-10-08 06:00:00.123456+00')," +
      "('pages-note-old','read-pages','agent','note','노트 이전 본문 전체','2026-10-08 06:00:00.123455+00')," +
      "('pages-note-new','read-pages','agent','note','노트 최신 본문 전체','2026-10-08 06:00:00.123456+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO card_reports(id,card_id,title,format,body,created_at) VALUES " +
      "('pages-report-old','read-pages','보고 이전','markdown','보고 이전 원문 전체','2026-10-08 06:00:00.123455+00')," +
      "('pages-report-new','read-pages','보고 최신','markdown','보고 최신 원문 전체','2026-10-08 06:00:00.123456+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO card_questions(id,card_id,text,answer,asked_at,answered_at) VALUES " +
      "('pages-q-old','read-pages','질문 이전','답변 이전','2026-10-08 06:00:00.123455+00','2026-10-08 06:00:00.223455+00')," +
      "('pages-q-new','read-pages','질문 최신',NULL,'2026-10-08 06:00:00.123456+00',NULL)",
    );
    await h.sql.unsafe(
      "INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,payload_json,created_at) VALUES " +
      "('pages-now-old','pas-a','card','read-pages','update_card_now',jsonb_build_object('text','옛 상황','turn','agent','ask',NULL),'2026-10-08 06:00:00.123455+00')," +
      "('pages-now-new','pas-a','card','read-pages','update_card_now',jsonb_build_object('text','최근 상황','turn','agent','ask',NULL),'2026-10-08 06:00:00.123456+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO sessions(session_id,folder_id,display_name,node_id,agent_id,status,card_id,created_at,updated_at) VALUES " +
      "('pages-session-old','pas-a','이전 세션','eiaserinnys','pas','completed','read-pages','2026-10-08 06:00:00.123455+00','2026-10-08 06:00:00.123455+00')," +
      "('pages-session-new','pas-a','최근 세션','eiaserinnys','pas','running','read-pages','2026-10-08 06:00:00.123456+00','2026-10-08 06:00:00.123456+00')",
    );

    const firstText = await reader.getCard("read-pages", { include: ["request"], text_limit: 4 }, null);
    expect(firstText.sections.request).toMatchObject({ text: "한글😀원", truncated: true });
    const secondText = await reader.getCard("read-pages", {
      include: ["request"], text_limit: 4, cursors: { request: firstText.sections.request.nextCursor! },
    }, null);
    expect(firstText.sections.request.text + secondText.sections.request.text).toBe("한글😀원문전체");
    expect(secondText.sections.request).toMatchObject({ nextCursor: null, truncated: false });
    const brief = await reader.getCard("read-pages", { include: ["brief"], text_limit: 3 }, null);
    const nextBrief = await reader.getCard("read-pages", {
      include: ["brief"], text_limit: 3, cursors: { brief: brief.sections.brief.nextCursor },
    }, null);
    expect(brief.sections.brief.text + nextBrief.sections.brief.text).toBe("인계😀본문");

    const include = ["attachments", "comments", "notes", "reports", "sessions", "now_history", "questions_history"] as const;
    const first = await reader.getCard("read-pages", { include: [...include], limit: 1 }, null);
    expect(first.sections.notes.items[0]).toMatchObject({ id: "pages-note-new", body: "노트 최신 본문 전체" });
    expect(first.sections.reports.items[0]).toMatchObject({ id: "pages-report-new", body: "보고 최신 원문 전체" });
    expect(first.sections.questions_history.items[0]).toMatchObject({ id: "pages-q-new" });
    expect(first.sections.now_history.items[0]).toMatchObject({ id: "pages-now-new", text: "최근 상황" });
    expect(first.sections.sessions.items[0]).toMatchObject({ sessionId: "pages-session-new", displayName: "최근 세션" });
    expect(first.sections.attachments.items[0]).toMatchObject({ name: "첫 첨부" });
    expect(first.sections.comments.items[0]).toMatchObject({ id: "pages-comment-new" });

    const cursors = Object.fromEntries(include.map((kind) => [kind, first.sections[kind].nextCursor]));
    const second = await reader.getCard("read-pages", { include: [...include], limit: 1, cursors }, null);
    expect(second.sections.notes.items[0]).toMatchObject({ id: "pages-note-old", body: "노트 이전 본문 전체" });
    expect(second.sections.reports.items[0]).toMatchObject({ id: "pages-report-old", body: "보고 이전 원문 전체" });
    expect(second.sections.questions_history.items[0]).toMatchObject({ id: "pages-q-old", answer: "답변 이전" });
    expect(second.sections.now_history.items[0]).toMatchObject({ id: "pages-now-old" });
    expect(second.sections.sessions.items[0]).toMatchObject({ sessionId: "pages-session-old" });
    expect(second.sections.comments.items[0]).toMatchObject({ id: "pages-comment-old" });
    expect(second.sections.attachments.items[0]).toMatchObject({ name: "둘 첨부" });
  });

  it("bounds list pages, scopes filters before paging, and requires explicit all", async () => {
    await h.sql.unsafe(
      "INSERT INTO cards(id,folder_id,position_key,title,request,status,archived,version) " +
      "SELECT 'list-' || lpad(n::text,2,'0'),'list-only',lpad(n::text,2,'0'),'목록 ' || n,''," +
      "CASE WHEN n % 2 = 0 THEN 'done' ELSE 'running' END,FALSE,1 FROM generate_series(1,21) n",
    );
    await seedCard({ id: "list-archived", folderId: "list-only", number: null, archived: true });
    await seedCard({ id: "list-system", folderId: "claude" });

    const page = await reader.listCards({ folder_id: "list-only" }, null);
    expect(page.cards).toHaveLength(20);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(Object.keys(page.cards[0]!).sort()).toEqual([
      "assigneeAgentId", "assigneeKind", "assigneeSessionId", "assigneeUserId", "id", "number", "status", "title", "updatedAt",
    ]);
    const next = await reader.listCards({ folder_id: "list-only", cursor: page.nextCursor! }, null);
    expect(next.cards).toHaveLength(1);
    expect(next.truncated).toBe(false);
    expect(next.cards.some((card) => card.id === "list-system" || card.id === "list-archived")).toBe(false);

    const done = await reader.listCards({ folder_id: "list-only", status: "done", limit: 20 }, ["list-only"]);
    expect(done.cards).toHaveLength(10);
    expect(done.cards.every((card) => card.status === "done")).toBe(true);
    expect((await reader.listCards({ all: true }, [])).cards).toEqual([]);
    expect((await reader.getCard("list-archived", {}, null)).card.number).toBeNull();
    expect((await reader.listCards({}, ["list-only"])).cards).toHaveLength(20);
    expect((await reader.listCards({ folder_id: "claude" }, null)).cards).toEqual([]);
    await expect(reader.getCard("list-system", {}, null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(reader.listCards({ all: true, folder_id: "list-only" }, null)).resolves.toMatchObject({
      cards: expect.any(Array), nextCursor: null, truncated: false,
    });
    await expect(reader.listCards({ all: true, limit: 20 }, null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.listCards({ all: true, cursor: page.nextCursor! }, null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.listCards({ folder_id: "pas-b" }, ["pas-a"])).rejects.toMatchObject({
      statusCode: 403, code: "FOLDER_ACCESS_DENIED",
    });
    await expect(reader.listCards({ limit: 51 }, null)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("detects same-version record and public-delivery changes, and returns replace pages", async () => {
    await seedCard({ id: "read-token", request: "request-v1", brief: "brief-v1" });
    await h.sql.unsafe(
      "INSERT INTO sessions(session_id,folder_id,display_name,node_id,agent_id,status,card_id,created_at,updated_at) " +
      "VALUES ('token-session','pas-a','세션 전','eiaserinnys','pas','running','read-token','2026-10-08 06:00:00.000001+00','2026-10-08 06:00:00.000001+00')",
    );
    await h.sql.unsafe(
      "INSERT INTO card_questions(id,card_id,text,asked_at) VALUES " +
      "('token-q-1','read-token','첫 질문','2026-10-08 06:00:00.000001+00')," +
      "('token-q-2','read-token','가운데 질문','2026-10-08 06:00:00.000002+00')," +
      "('token-q-3','read-token','마지막 질문','2026-10-08 06:00:00.000003+00')",
    );

    const same = await reader.getCard("read-token", {}, null);
    const unchanged = await reader.getCard("read-token", { since: same.changeToken }, null);
    expect(unchanged).toEqual({ id: "read-token", unchanged: true, changeToken: same.changeToken });

    await h.sql.unsafe("UPDATE card_questions SET answer='답변',answered_at='2026-10-08 06:01:00.000001+00' WHERE id='token-q-2'");
    const questionChange = await reader.getCard("read-token", { since: same.changeToken }, null);
    expect(questionChange).toMatchObject({ unchanged: false });
    expect(questionChange.changed).toEqual(expect.arrayContaining(["questions", "questions_history"]));
    expect(questionChange.questions).toMatchObject({ replace: true });
    expect(questionChange.questions.items.map((question: { text: string }) => question.text)).toEqual(["마지막 질문", "첫 질문"]);

    const beforeNote = await reader.getCard("read-token", {}, null);
    await h.sql.unsafe(
      "INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES " +
      "('token-note','read-token','agent','note','새 노트','2026-10-08 06:02:00.000001+00')",
    );
    const noteChange = await reader.getCard("read-token", { since: beforeNote.changeToken, include: ["notes"], limit: 1 }, null);
    expect(noteChange.changed).toContain("notes");
    expect(noteChange.sections.notes).toMatchObject({ replace: true, items: [{ id: "token-note", body: "새 노트" }] });
    expect(noteChange.card).toBeUndefined();

    const beforeSession = await reader.getCard("read-token", {}, null);
    await h.sql.unsafe("UPDATE sessions SET display_name='세션 후' WHERE session_id='token-session'");
    const sessionChange = await reader.getCard("read-token", { since: beforeSession.changeToken }, null);
    expect(sessionChange.changed).toContain("sessions");
    expect(sessionChange).not.toHaveProperty("sections");
    const beforeDelivery = await reader.getCard("read-token", {}, null);
    await h.sql.unsafe(
      "INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES " +
      "('token-comment','read-token','agent','comment','전달 댓글','2026-10-08 06:03:00.000001+00')",
    );
    const beforeDelivered = await reader.getCard("read-token", {}, null);
    expect((await reader.getCard("read-token", { since: beforeDelivery.changeToken }, null)).changed).toContain("comments");
    await h.sql.unsafe("UPDATE card_comments SET delivered_at='2026-10-08 06:04:00.000001+00' WHERE id='token-comment'");
    const deliveryChange = await reader.getCard("read-token", { since: beforeDelivered.changeToken }, null);
    expect(deliveryChange.changed).toContain("comments");
    expect(beforeDelivery.card.version).toBe(beforeDelivered.card.version);

    const beforeRequest = await reader.getCard("read-token", {}, null);
    await h.sql.unsafe("UPDATE cards SET request='request-v2' WHERE id='read-token'");
    const hiddenRequestChange = await reader.getCard("read-token", { since: beforeRequest.changeToken }, null);
    expect(hiddenRequestChange.changed).toEqual(["request"]);
    const replacedRequest = await reader.getCard("read-token", {
      since: beforeRequest.changeToken, include: ["request"],
    }, null);
    expect(replacedRequest.sections.request).toMatchObject({
      text: "request-v2", replace: true, nextCursor: null, truncated: false,
    });

    const beforeCard = await reader.getCard("read-token", {}, null);
    await h.sql`
      UPDATE cards SET version=version+1,items=${h.sql.json([{
        id: 1, title: "결과", state: "done", result: "완료", evidence: [], caveat: null, rev: 1,
        confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: "2026-10-08T06:00:00.000Z", reportedAt: null,
      }])} WHERE id='read-token'
    `;
    const cardChange = await reader.getCard("read-token", { since: beforeCard.changeToken }, null);
    expect(cardChange.changed).toContain("card");
    expect(cardChange.card.items[0]).toMatchObject({ result: "완료", display: "reported" });

    const beforeReport = await reader.getCard("read-token", {}, null);
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body)
      VALUES ('token-report','read-token','보고','markdown','보고 원문')`;
    const reportChange = await reader.getCard("read-token", { since: beforeReport.changeToken, include: ["reports"] }, null);
    expect(reportChange.changed).toEqual(["reports"]);
    expect(reportChange.sections.reports).toMatchObject({ replace: true, items: [{ body: "보고 원문" }] });

    const beforeStatus = await reader.getCard("read-token", {}, null);
    await h.sql`UPDATE sessions SET status='completed' WHERE session_id='token-session'`;
    const statusChange = await reader.getCard("read-token", { since: beforeStatus.changeToken, include: ["sessions"] }, null);
    expect(statusChange.changed).toEqual(["sessions"]);
    expect(statusChange.sections.sessions).toMatchObject({ replace: true, items: [{ status: "completed" }] });
    const beforeDetach = await reader.getCard("read-token", {}, null);
    await h.sql`UPDATE sessions SET card_id=NULL WHERE session_id='token-session'`;
    const detachChange = await reader.getCard("read-token", { since: beforeDetach.changeToken, include: ["sessions"] }, null);
    expect(detachChange.changed).toEqual(["sessions"]);
    expect(detachChange.sections.sessions).toMatchObject({ replace: true, items: [] });
    expect((await reader.getCard("read-token", {}, null)).card.version).toBe(beforeReport.card.version);

    const beforeNow = await reader.getCard("read-token", {}, null);
    await h.sql`UPDATE cards SET now=${h.sql.json({ text: "새 상황", turn: "agent", ask: null })},version=version+1 WHERE id='read-token'`;
    expect((await reader.getCard("read-token", { since: beforeNow.changeToken }, null)).card.now.text).toBe("새 상황");
  });

  it("rejects malformed, mismatched, or unauthorized card references", async () => {
    await seedCard({ id: "read-security", folderId: "pas-a" });
    await seedCard({ id: "read-other", folderId: "pas-b" });
    await h.sql.unsafe(
      "INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES " +
      "('security-note-old','read-security','agent','note','이전 노트','2026-10-08 06:00:00.000001+00')," +
      "('security-note-new','read-security','agent','note','최근 노트','2026-10-08 06:00:00.000002+00')",
    );

    const current = await reader.getCard("read-security", {}, ["pas-a"]);
    for (const input of [{}, { include: ["notes"] as const }, { since: current.changeToken }]) {
      await expect(reader.getCard("read-security", input as CardMcpGetInput, ["pas-b"]))
        .rejects.toMatchObject({ statusCode: 403, code: "FOLDER_ACCESS_DENIED" });
    }
    await expect(reader.listCards({ folder_id: "pas-a", all: true }, ["pas-b"]))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(reader.getCard("read-other", { since: current.changeToken }, ["pas-b"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.getCard("read-security", { text_limit: 4001 }, ["pas-a"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.getCard("missing-card", {}, null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(reader.getCard("read-other", {}, ["pas-a"])).rejects.toMatchObject({
      statusCode: 403, code: "FOLDER_ACCESS_DENIED",
    });
    await expect(reader.getCard("read-security", { include: ["notes"], cursors: { reports: "x" } as never }, ["pas-a"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.getCard("read-security", { since: "not-a-token" }, ["pas-a"]))
      .rejects.toMatchObject({ statusCode: 400 });
    const cursor = (await reader.getCard("read-security", { include: ["notes"], limit: 1 }, ["pas-a"]))
      .sections.notes.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    await expect(reader.getCard("read-other", { include: ["notes"], cursors: { notes: cursor } }, ["pas-b"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.getCard("read-security", { since: current.changeToken, cursors: { notes: cursor }, include: ["notes"] }, ["pas-a"]))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(reader.getCard("read-security", {}, []))
      .rejects.toMatchObject({ statusCode: 403, code: "FOLDER_ACCESS_DENIED" });
    await expect(reader.getCard("read-security", { include: ["notes"], all: true } as never, ["pas-a"]))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("keeps current fingerprints and pages in one read-only repeatable-read snapshot", async () => {
    await seedCard({ id: "read-snapshot" });
    await h.sql`INSERT INTO card_questions(id,card_id,text) VALUES ('snapshot-q','read-snapshot','답변 대기')`;
    const repository = new CardMcpReadRepository(createBoardYjsSqlAdapter(h.liveSql));
    const before = await reader.getCard("read-snapshot", {}, null);
    const snapshot = await repository.withCardSnapshot("read-snapshot", null, async ({ sql, current }) => {
      const [mode] = await sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only`;
      expect(mode).toEqual({ isolation: "repeatable read", read_only: "on" });
      await h.peerSql`UPDATE card_questions SET answer='확인',answered_at=now() WHERE id='snapshot-q'`;
      const questions = await repository.readQuestionPage(sql, "read-snapshot", 20, null);
      return { current, questions };
    });
    expect(snapshot.questions).toMatchObject({ items: [{ id: "snapshot-q", answer: null }] });
    const after = await reader.getCard("read-snapshot", { since: before.changeToken }, null);
    expect(after.questions).toMatchObject({ replace: true, items: [] });
    expect(after.changed).toEqual(["questions", "questions_history"]);
  });
});
