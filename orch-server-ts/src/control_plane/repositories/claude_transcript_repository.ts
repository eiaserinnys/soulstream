import type {
  ClaudeTranscriptEntry,
  ClaudeTranscriptKey,
  ClaudeTranscriptSessionSummary,
  SqlClient,
} from "../control_plane_types.js";
import {
  isClaudeTranscriptEntry,
  normalizeTranscriptSubpath,
} from "../repository_helpers.js";
import { runIdempotentSessionMutation } from "./idempotent_session_mutation.js";

export interface IdempotentClaudeTranscriptAppend {
  idempotencyKey: string;
  sessionId: string;
  key: ClaudeTranscriptKey;
  entries: ClaudeTranscriptEntry[];
}

export interface IdempotentClaudeTranscriptDelete {
  idempotencyKey: string;
  sessionId: string;
  key: ClaudeTranscriptKey;
}

export class ClaudeTranscriptRepository {
  constructor(private readonly sql: SqlClient) {}

  async appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number> {
    return await appendClaudeTranscriptEntries(this.sql, key, entries);
  }

  async appendClaudeTranscriptEntriesIdempotent(
    input: IdempotentClaudeTranscriptAppend,
  ): Promise<number> {
    return await runIdempotentSessionMutation(
      this.sql,
      "runner_claude_transcript_append",
      input,
      async (sql) => await appendClaudeTranscriptEntries(sql, input.key, input.entries),
    );
  }

  async deleteClaudeTranscriptIdempotent(
    input: IdempotentClaudeTranscriptDelete,
  ): Promise<void> {
    await runIdempotentSessionMutation(
      this.sql,
      "runner_claude_transcript_delete",
      input,
      async (sql) => {
        await deleteClaudeTranscript(sql, input.key);
        return null;
      },
    );
  }

  async loadClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
  ): Promise<ClaudeTranscriptEntry[] | null> {
    const rows = await this.sql<Array<{ entry: unknown }>>`
      SELECT * FROM claude_transcript_load(
        ${key.projectKey},
        ${key.sessionId},
        ${normalizeTranscriptSubpath(key.subpath)}
      )
    `;
    if (rows.length === 0) return null;
    return rows
      .map((row) => row.entry)
      .filter(isClaudeTranscriptEntry);
  }

  async listClaudeTranscriptSessions(
    projectKey: string,
  ): Promise<ClaudeTranscriptSessionSummary[]> {
    const rows = await this.sql<Array<{ session_id: string; mtime: string | number }>>`
      SELECT * FROM claude_transcript_list_sessions(${projectKey})
    `;
    return rows.map((row) => ({
      sessionId: row.session_id,
      mtime: Number(row.mtime),
    }));
  }

  async listClaudeTranscriptSubkeys(
    key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">,
  ): Promise<string[]> {
    const rows = await this.sql<Array<{ subpath: string }>>`
      SELECT * FROM claude_transcript_list_subkeys(${key.projectKey}, ${key.sessionId})
    `;
    return rows.map((row) => row.subpath);
  }

  async deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void> {
    await deleteClaudeTranscript(this.sql, key);
  }
}

async function appendClaudeTranscriptEntries(
  sql: SqlClient,
  key: ClaudeTranscriptKey,
  entries: ClaudeTranscriptEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const rows = await sql<{ claude_transcript_append: string | number }[]>`
    SELECT claude_transcript_append(
      ${key.projectKey},
      ${key.sessionId},
      ${normalizeTranscriptSubpath(key.subpath)},
      ${JSON.stringify(entries)},
      ${new Date()}
    ) AS claude_transcript_append
  `;
  return Number(rows[0]?.claude_transcript_append ?? 0);
}

async function deleteClaudeTranscript(
  sql: SqlClient,
  key: ClaudeTranscriptKey,
): Promise<void> {
  await sql`
    SELECT claude_transcript_delete(
      ${key.projectKey},
      ${key.sessionId},
      ${normalizeTranscriptSubpath(key.subpath)}
    )
  `;
}
