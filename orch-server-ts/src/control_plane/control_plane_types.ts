import type postgres from "postgres";

export interface ClaudeTranscriptKey {
  projectKey: string;
  sessionId: string;
  subpath?: string | null;
}

export type ClaudeTranscriptEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export interface ClaudeTranscriptSessionSummary {
  sessionId: string;
  mtime: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;
