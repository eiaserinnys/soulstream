import type { SupervisedCardSnapshot } from "@soulstream/mcp-contract";

import type { RepositorySql } from "./control_plane/card_types.js";

export type { SupervisedCardSnapshot } from "@soulstream/mcp-contract";

export async function readSupervisedCardContext(
  sql: RepositorySql,
  params: {
    sessionId: string;
    folderIds: string[] | null;
    cardLimit: number;
    questionLimit: number;
  },
): Promise<SupervisedCardSnapshot> {
  const folderIds = params.folderIds as unknown as string[] | null;
  const countRows = await sql<Array<{ status: string; count: number | string }>>`
    SELECT c.status, COUNT(*)::integer AS count
    FROM cards c
    JOIN folders f ON f.id = c.folder_id
    WHERE c.archived = FALSE
      AND f.archived = FALSE
      AND c.status = ANY(ARRAY['running', 'blocked', 'review', 'queued', 'todo']::text[])
      AND (${folderIds as unknown as string[] | null}::text[] IS NULL
        OR c.folder_id = ANY(${folderIds as unknown as string[] | null}::text[]))
    GROUP BY c.status
  `;
  const cardRows = await sql<Array<{
    id: string;
    title: string;
    status: "running" | "blocked" | "review" | "queued";
    blocked_kind: "limit" | "question" | "no_report" | null;
    assignee_kind: "agent" | "session" | "human" | null;
    assignee_agent_id: string | null;
    assignee_session_id: string | null;
    session_agent_id: string | null;
  }>>`
    SELECT
      c.id,
      LEFT(c.title, 161) AS title,
      c.status,
      c.blocked_kind,
      c.assignee_kind,
      c.assignee_agent_id,
      c.assignee_session_id,
      s.agent_id AS session_agent_id
    FROM cards c
    JOIN folders f ON f.id = c.folder_id
    LEFT JOIN sessions s ON s.session_id = c.assignee_session_id
    WHERE c.archived = FALSE
      AND f.archived = FALSE
      AND c.status = ANY(ARRAY['running', 'blocked', 'review', 'queued']::text[])
      AND (${folderIds as unknown as string[] | null}::text[] IS NULL
        OR c.folder_id = ANY(${folderIds as unknown as string[] | null}::text[]))
    ORDER BY
      array_position(ARRAY['running', 'blocked', 'review', 'queued']::text[], c.status),
      c.queue_position_key COLLATE "C" NULLS LAST,
      c.status_changed_at DESC,
      c.id COLLATE "C"
    LIMIT ${params.cardLimit}
  `;
  const questionRows = await sql<Array<{
    id: string;
    card_id: string;
    card_title: string;
    text: string;
    asked_at: Date | string;
    total_count: number | string;
  }>>`
    SELECT
      q.id,
      q.card_id,
      LEFT(c.title, 161) AS card_title,
      LEFT(q.text, 400) AS text,
      q.asked_at,
      COUNT(*) OVER ()::integer AS total_count
    FROM card_questions q
    JOIN cards c ON c.id = q.card_id
    WHERE q.session_id = ${params.sessionId}
      AND q.answer IS NULL
      AND c.archived = FALSE
    ORDER BY q.asked_at DESC, q.id COLLATE "C" DESC
    LIMIT ${params.questionLimit}
  `;

  const counts = {
    running: 0,
    blocked: 0,
    review: 0,
    queued: 0,
    todo: 0,
  };
  for (const row of countRows) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = Number(row.count);
  }
  return {
    capturedAt: new Date().toISOString(),
    counts,
    cards: cardRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      blockedKind: row.blocked_kind,
      assignee: {
        kind: row.assignee_kind,
        agentId: row.assignee_agent_id ?? row.session_agent_id,
        sessionId: row.assignee_session_id,
      },
    })),
    openQuestions: questionRows.map((row) => ({
      id: row.id,
      cardId: row.card_id,
      cardTitle: row.card_title,
      text: row.text,
      askedAt: iso(row.asked_at),
    })),
    openQuestionTotal: Number(questionRows[0]?.total_count ?? 0),
  };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
