import type { Logger } from "pino";

import {
  isSessionDataHostError,
  type SessionResumeContext,
} from "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";

export type InitialResumeContext = Omit<SessionResumeContext, "session"> & {
  session: SessionResumeContext["session"] | undefined;
};

export async function loadInitialResumeContext(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  limit: number,
): Promise<InitialResumeContext> {
  try {
    return await db.getResumeContext(sessionId, limit);
  } catch (error) {
    if (
      !isSessionDataHostError(error)
      || error.operation !== "resume_context"
      || !error.retryable
    ) {
      throw error;
    }
    logger.warn(
      { err: error, sessionId },
      "resume context unavailable; continuing new session without optional workspace context",
    );
    return {
      session: undefined,
      folderSessions: { sessions: [], total: 0 },
      runningSessions: { sessions: [], total: 0 },
      predecessor: null,
    };
  }
}
