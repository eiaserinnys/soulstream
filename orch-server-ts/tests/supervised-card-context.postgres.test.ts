import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { readSupervisedCardContext } from "../src/cards/supervised_card_context.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

describe("readSupervisedCardContext", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql.unsafe("INSERT INTO folders(id, name, archived) VALUES ('folder-a', 'A', FALSE), ('folder-b', 'B', FALSE), ('folder-archived', 'Archived', TRUE)");
    await harness.sql.unsafe("INSERT INTO sessions(session_id, status, agent_id, caller_session_id, display_name, card_id) VALUES ('owner', 'running', 'supervisor', NULL, 'Supervisor', NULL), ('assigned-session', 'running', 'worker-agent', NULL, 'Worker', NULL)");
  }, 60_000);

  afterAll(async () => await harness?.cleanup());

  beforeEach(async () => {
    await harness.sql.unsafe("DELETE FROM card_questions");
    await harness.sql.unsafe("DELETE FROM cards");
  });

  it("counts and orders only active cards in active folders, and includes this session's open questions", async () => {
    await harness.sql.unsafe(`
      INSERT INTO cards(id, folder_id, position_key, queue_position_key, title, status, blocked_kind, assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id, status_changed_at, archived)
      VALUES
        ('run-1', 'folder-a', 'a', NULL, '실행 중', 'running', NULL, 'agent', 'roselin', NULL, NULL, NOW(), FALSE),
        ('blocked-queued', 'folder-a', 'b', 'a', '한도 막힘', 'blocked', 'limit', 'session', NULL, 'assigned-session', NULL, NOW() - INTERVAL '1 minute', FALSE),
        ('blocked-question', 'folder-a', 'c', NULL, '질문 막힘', 'blocked', 'question', 'human', NULL, NULL, 'user-1', NOW(), FALSE),
        ('review-1', 'folder-a', 'd', NULL, '검수 대기', 'review', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('queued-first', 'folder-a', 'e', 'a', '먼저 대기', 'queued', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('queued-last', 'folder-a', 'f', NULL, '나중 대기', 'queued', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('todo-1', 'folder-a', 'g', NULL, '드래프트', 'todo', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('done-1', 'folder-a', 'h', NULL, '완료', 'done', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('cancelled-1', 'folder-a', 'i', NULL, '취소', 'cancelled', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('archived-card', 'folder-a', 'j', NULL, '보관 카드', 'running', NULL, NULL, NULL, NULL, NULL, NOW(), TRUE),
        ('archived-folder-card', 'folder-archived', 'k', NULL, '보관 폴더 카드', 'running', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE),
        ('other-folder-card', 'folder-b', 'l', NULL, '다른 폴더', 'running', NULL, NULL, NULL, NULL, NULL, NOW(), FALSE)
    `);
    await harness.sql.unsafe(`
      INSERT INTO card_questions(id, card_id, session_id, text, answer, asked_at)
      VALUES
        ('q-own-a', 'run-1', 'owner', 'A 폴더 질문', NULL, NOW()),
        ('q-own-b', 'other-folder-card', 'owner', '다른 폴더 질문', NULL, NOW() - INTERVAL '1 minute'),
        ('q-other', 'run-1', 'assigned-session', '다른 세션 질문', NULL, NOW()),
        ('q-answered', 'run-1', 'owner', '이미 답함', '완료', NOW()),
        ('q-archived-card', 'archived-card', 'owner', '보관 카드 질문', NULL, NOW())
    `);

    const sql = createBoardYjsSqlAdapter(harness.liveSql);
    const snapshot = await readSupervisedCardContext(sql, {
      sessionId: "owner",
      folderIds: ["folder-a"],
      cardLimit: 60,
      questionLimit: 10,
    });

    expect(snapshot.counts).toEqual({ running: 1, blocked: 2, review: 1, queued: 2, todo: 1 });
    expect(snapshot.cards.map((card) => card.id)).toEqual([
      "run-1",
      "blocked-queued",
      "blocked-question",
      "review-1",
      "queued-first",
      "queued-last",
    ]);
    expect(snapshot.cards.find((card) => card.id === "blocked-queued")?.assignee).toEqual({
      kind: "session",
      agentId: "worker-agent",
      sessionId: "assigned-session",
    });
    expect(snapshot.openQuestions.map((question) => question.cardId)).toEqual([
      "run-1",
      "other-folder-card",
    ]);
    expect(snapshot.openQuestionTotal).toBe(2);

    const limited = await readSupervisedCardContext(sql, {
      sessionId: "owner",
      folderIds: ["folder-a"],
      cardLimit: 1,
      questionLimit: 1,
    });
    expect(limited.cards.map((card) => card.id)).toEqual(["run-1"]);
    expect(limited.counts).toEqual(snapshot.counts);
    expect(limited.openQuestions).toHaveLength(1);
    expect(limited.openQuestionTotal).toBe(2);
  });
});
