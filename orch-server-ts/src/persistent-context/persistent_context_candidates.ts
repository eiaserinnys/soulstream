import type { LiveSearchDbConnectionFactory, LiveSearchQueryRunner } from "../runtime/live_db_sql.js";
import { withLiveSearchDbConnection } from "../runtime/live_db_sql.js";
import type { SessionStoryReadRepository } from "../control_plane/repositories/session_story_read_repository.js";
import type { PersistentContextRawCandidates } from "./persistent_context_types.js";

export type PersistentContextCandidateRepositories = {
  readonly readSessionAndBoundedCandidates: (
    sessionId: string,
    inputId: string,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<PersistentContextRawCandidates>;
  readonly storyReads: SessionStoryReadRepository;
};

export function createPersistentContextCandidateRepositories(options: {
  readonly searchDbConnectionFactory: LiveSearchDbConnectionFactory;
  readonly storyReads: SessionStoryReadRepository;
  readonly onCancelError?: (error: unknown) => void;
}): PersistentContextCandidateRepositories {
  const run = <T>(signal: AbortSignal, deadlineAt: number, operation: (query: LiveSearchQueryRunner) => Promise<T>) =>
    withLiveSearchDbConnection(
      options.searchDbConnectionFactory,
      signal,
      (error) => options.onCancelError?.(error),
      operation,
      deadlineAt,
    );

  return {
    storyReads: options.storyReads,
    async readSessionAndBoundedCandidates(sessionId, inputId, signal, deadlineAt) {
      return run(signal, deadlineAt, async (query) => {
        const sessionRows = await query((sql) => sql<Array<{
          persistent: boolean;
          input_event_id: number | string | null;
        }>>`
          SELECT
            COALESCE(latest_marker.value->'value'->>'enabled' = 'true', false) AS persistent,
            (
              SELECT input_event.id
              FROM events input_event
              WHERE input_event.session_id = session.session_id
                AND input_event.event_type = 'user_message'
                AND input_event.payload->>'input_id' = ${inputId}
              ORDER BY input_event.id DESC
              LIMIT 1
            ) AS input_event_id
          FROM sessions session
          LEFT JOIN LATERAL (
            SELECT marker.value
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(session.metadata) = 'array'
                THEN session.metadata ELSE '[]'::jsonb END
            ) WITH ORDINALITY AS marker(value, ordinal)
            WHERE marker.value->>'type' = 'persistent_session'
            ORDER BY marker.ordinal DESC
            LIMIT 1
          ) latest_marker ON TRUE
          WHERE session.session_id = ${sessionId}
            AND COALESCE(session.session_type, 'claude') <> 'llm'
        `);
        const session = sessionRows[0];
        const inputEventId = session?.input_event_id == null ? null : Number(session.input_event_id);
        if (!session || inputEventId === null) {
          return {
            sessionIsPersistent: session?.persistent === true,
            inputEventId,
            turnSummaries: [],
            allowedFolderIds: [],
            cards: [],
            recentCompletedSessions: [],
          };
        }
        if (session.persistent !== true) {
          return {
            sessionIsPersistent: false,
            inputEventId,
            turnSummaries: [],
            allowedFolderIds: [],
            cards: [],
            recentCompletedSessions: [],
          };
        }

        const folderRows = await query((sql) => sql<Array<{ id: string }>>`
          SELECT id
          FROM folders
          WHERE NOT archived
            AND COALESCE(settings->>'excludeFromFeed', 'false') <> 'true'
        `);
        const allowedFolderIds = folderRows.map((row) => row.id);

        const cardRows = await query((sql) => sql<Array<{
          id: string;
          number: number | string | null;
          title: string;
          request: string;
          brief: string;
        }>>`
          SELECT c.id, c.number, c.title, c.request, c.brief
          FROM cards c
          JOIN folders f ON f.id = c.folder_id
          WHERE NOT c.archived
            AND NOT f.archived
            AND COALESCE(f.settings->>'excludeFromFeed', 'false') <> 'true'
            AND f.id = ANY(${allowedFolderIds}::text[])
            AND c.status = ANY(ARRAY['todo', 'queued', 'blocked', 'running', 'review']::text[])
          ORDER BY
            CASE WHEN c.assignee_kind = 'session' AND c.assignee_session_id = ${sessionId} THEN 0 ELSE 1 END ASC,
            array_position(ARRAY['running', 'blocked', 'review', 'queued', 'todo']::text[], c.status),
            c.updated_at DESC,
            c.id COLLATE "C"
          LIMIT 20
        `);

        const recentRows = await query((sql) => sql<Array<{
          session_id: string;
          display_name: string | null;
          first_request: string | null;
        }>>`
          -- Updated_at bounds the window; terminal event time determines the exact final order inside it.
          WITH recent AS (
            SELECT completed.session_id, completed.display_name,
              completed.termination_event_id, completed.updated_at
            FROM sessions completed
            WHERE completed.status = 'completed'
              AND completed.session_id <> ${sessionId}
              AND COALESCE(completed.session_type, 'claude') <> 'llm'
              AND completed.folder_id = ANY(${allowedFolderIds}::text[])
            ORDER BY completed.updated_at DESC, completed.session_id COLLATE "C"
            LIMIT 50
          ), ordered_recent AS (
            SELECT recent.session_id, recent.display_name, recent.updated_at,
              terminal.created_at AS terminal_created_at
            FROM recent
            LEFT JOIN events terminal
              ON terminal.session_id = recent.session_id
              AND terminal.id = recent.termination_event_id
            ORDER BY COALESCE(terminal.created_at, recent.updated_at) DESC,
              recent.session_id COLLATE "C"
            LIMIT 5
          )
          SELECT ordered_recent.session_id, ordered_recent.display_name,
            first_input.searchable_text AS first_request
          FROM ordered_recent
          LEFT JOIN LATERAL (
            SELECT event.searchable_text
            FROM events event
            WHERE event.session_id = ordered_recent.session_id
              AND event.event_type = 'user_message'
            ORDER BY event.id ASC
            LIMIT 1
          ) first_input ON TRUE
          ORDER BY COALESCE(ordered_recent.terminal_created_at, ordered_recent.updated_at) DESC,
            ordered_recent.session_id COLLATE "C"
        `);
        return {
          sessionIsPersistent: session.persistent === true,
          inputEventId,
          allowedFolderIds,
          turnSummaries: [],
          cards: cardRows.map((row) => ({
            id: row.id,
            number: row.number == null ? null : Number(row.number),
            title: row.title,
            request: row.request,
            brief: row.brief,
          })),
          recentCompletedSessions: recentRows.map((row) => ({
            sessionId: row.session_id,
            title: row.display_name ?? "",
            firstRequest: row.first_request ?? "",
          })),
        };
      });
    },
  };
}
