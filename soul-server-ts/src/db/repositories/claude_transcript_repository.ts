import type {
  ClaudeTranscriptEntry,
  ClaudeTranscriptKey,
  ClaudeTranscriptSessionSummary,
  SqlClient,
} from "../session_db_types.js";
import {
  isClaudeTranscriptEntry,
  normalizeTranscriptSubpath,
} from "./repository_helpers.js";

export class ClaudeTranscriptRepository {
  constructor(private readonly sql: SqlClient) {}

  async appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const rows = await this.sql<{ claude_transcript_append: string | number }[]>`
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
    await this.sql`
      SELECT claude_transcript_delete(
        ${key.projectKey},
        ${key.sessionId},
        ${normalizeTranscriptSubpath(key.subpath)}
      )
    `;
  }
}
