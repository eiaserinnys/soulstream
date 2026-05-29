import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ClaudeTranscriptEntry,
  ClaudeTranscriptKey,
  ClaudeTranscriptSessionSummary,
} from "../db/session_db.js";

export interface ClaudeTranscriptStoreDb {
  appendClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
    entries: ClaudeTranscriptEntry[],
  ): Promise<number>;
  loadClaudeTranscriptEntries(
    key: ClaudeTranscriptKey,
  ): Promise<ClaudeTranscriptEntry[] | null>;
  listClaudeTranscriptSessions(projectKey: string): Promise<ClaudeTranscriptSessionSummary[]>;
  listClaudeTranscriptSubkeys(
    key: Pick<ClaudeTranscriptKey, "projectKey" | "sessionId">,
  ): Promise<string[]>;
  deleteClaudeTranscript(key: ClaudeTranscriptKey): Promise<void>;
}

export class DbClaudeSessionStore implements SessionStore {
  constructor(private readonly db: ClaudeTranscriptStoreDb) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.db.appendClaudeTranscriptEntries(normalizeKey(key), entries);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return await this.db.loadClaudeTranscriptEntries(normalizeKey(key));
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return await this.db.listClaudeTranscriptSessions(projectKey);
  }

  async delete(key: SessionKey): Promise<void> {
    await this.db.deleteClaudeTranscript(normalizeKey(key));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return await this.db.listClaudeTranscriptSubkeys(key);
  }
}

function normalizeKey(key: SessionKey): ClaudeTranscriptKey {
  return {
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath ? { subpath: key.subpath } : {}),
  };
}
