import type { RepositorySql } from "./control_plane/card_types.js";

/**
 * The only place that decides how things inside a card are numbered (`#412.s2`, `.r1`, `.q1`, `.c3`).
 * Ordinals are counted when read, never stored: 1 for the earliest, by the order below.
 *
 *   s  sessions.card_id = card   created_at, session_id
 *   r  card_reports              created_at, id
 *   q  card_questions            asked_at, id
 *   c  card_comments             created_at, id   (every row; notes count like any other comment)
 */
export interface CardChildOrdinals {
  sessions: Map<string, number>;
  reports: Map<string, number>;
  questions: Map<string, number>;
  comments: Map<string, number>;
}

type NumberedSession = { card_id: string; session_id: string; display_name: string | null; ordinal: number };

/** Every session attached to the given cards, numbered per card. All session numbering goes through here. */
async function numberedSessions(sql: RepositorySql, cardIds: string[]): Promise<NumberedSession[]> {
  if (cardIds.length === 0) return [];
  return [...await sql<NumberedSession[]>`
    SELECT card_id, session_id, display_name,
      ROW_NUMBER() OVER (PARTITION BY card_id ORDER BY created_at, session_id COLLATE "C")::int AS ordinal
    FROM sessions WHERE card_id = ANY(${sql.array(cardIds)}::text[])`];
}

async function ordinalsOf(sql: RepositorySql, rows: Promise<readonly { id: string; ordinal: number }[]>): Promise<Map<string, number>> {
  return new Map((await rows).map(row => [row.id, row.ordinal]));
}

export async function readCardChildOrdinals(sql: RepositorySql, cardId: string): Promise<CardChildOrdinals> {
  const [sessions, reports, questions, comments] = await Promise.all([
    numberedSessions(sql, [cardId]),
    ordinalsOf(sql, sql`SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id COLLATE "C")::int AS ordinal
      FROM card_reports WHERE card_id = ${cardId}`),
    ordinalsOf(sql, sql`SELECT id, ROW_NUMBER() OVER (ORDER BY asked_at, id COLLATE "C")::int AS ordinal
      FROM card_questions WHERE card_id = ${cardId}`),
    ordinalsOf(sql, sql`SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id COLLATE "C")::int AS ordinal
      FROM card_comments WHERE card_id = ${cardId}`),
  ]);
  return { sessions: new Map(sessions.map(row => [row.session_id, row.ordinal])), reports, questions, comments };
}

/** Sessions on a card that has a number. A session on a numberless card, or on no card, is not in the result. */
export async function readSessionReferences(
  sql: RepositorySql, sessionIds: string[],
): Promise<Map<string, { cardNumber: number; ordinal: number }>> {
  if (sessionIds.length === 0) return new Map();
  const cards = await sql<{ id: string; number: number }[]>`
    SELECT DISTINCT c.id, c.number FROM sessions s JOIN cards c ON c.id = s.card_id
    WHERE s.session_id = ANY(${sql.array(sessionIds)}::text[]) AND c.number IS NOT NULL`;
  const numberOf = new Map(cards.map(card => [card.id, card.number]));
  const wanted = new Set(sessionIds);
  return new Map((await numberedSessions(sql, [...numberOf.keys()]))
    .filter(row => wanted.has(row.session_id))
    .map(row => [row.session_id, { cardNumber: numberOf.get(row.card_id)!, ordinal: row.ordinal }]));
}

/** Cards by number, archived or not. A numberless card has no number to ask for. */
export async function findCardsByNumber(
  sql: RepositorySql, numbers: number[],
): Promise<Array<{ id: string; number: number; title: string; folder_id: string }>> {
  if (numbers.length === 0) return [];
  return [...await sql<Array<{ id: string; number: number; title: string; folder_id: string }>>`
    SELECT id, number, title, folder_id FROM cards WHERE number = ANY(${sql.array(numbers)}::int[])`];
}

export async function findCardSessionByOrdinal(
  sql: RepositorySql, cardId: string, ordinal: number,
): Promise<{ session: { session_id: string; display_name: string | null } | null; total: number }> {
  const rows = await numberedSessions(sql, [cardId]);
  const found = rows.find(row => row.ordinal === ordinal);
  return { session: found ? { session_id: found.session_id, display_name: found.display_name } : null, total: rows.length };
}
