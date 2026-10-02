import { generateKeyBetween } from "@soulstream/fractional-position";
import type { CardRow, FolderActorParams, RepositorySql } from "./card_types.js";

/** The move-only transaction boundary shared by card and session-tree moves. */
export async function applyCardMoveTx(
  sql: RepositorySql,
  card: CardRow,
  folderId: string,
  afterCardId: string | null,
  actor: FolderActorParams,
  eventId: number | null,
): Promise<void> {
  const folders = await sql`SELECT id FROM folders WHERE id=${folderId} FOR UPDATE`;
  if (!folders.length) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
  const rows = await sql<{ id: string; key: string }[]>`
    SELECT id, position_key AS key FROM cards
    WHERE folder_id=${folderId} AND id IS DISTINCT FROM ${card.id}
    ORDER BY position_key COLLATE "C", id
  `;
  const anchor = afterCardId === null ? rows.length - 1 : rows.findIndex(row => row.id === afterCardId);
  if (afterCardId !== null && anchor < 0) {
    throw Object.assign(new Error("Position anchor not found in target list"), {
      statusCode: 422, code: "INVALID_CARD_REQUEST",
    });
  }
  const position = generateKeyBetween(rows[anchor]?.key ?? null, rows[anchor + 1]?.key ?? null);
  await sql`UPDATE cards SET folder_id=${folderId}, position_key=${position},
    version=version+1, updated_at=NOW(), updated_session_id=${actor.actorSessionId},
    updated_event_id=${eventId} WHERE id=${card.id}`;
}
