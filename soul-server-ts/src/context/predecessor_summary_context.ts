import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";

import type { ContextItem } from "./prompt_assembler.js";
import { buildSessionTurnExcerpt } from "./session_turn_summary.js";

export async function buildPredecessorSummaryContextItem(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
): Promise<ContextItem | null> {
  try {
    const current = await db.getSession(sessionId);
    const predecessorId = current?.predecessor_session_id;
    if (!predecessorId) return null;
    const predecessor = await db.getSession(predecessorId);
    if (!predecessor) {
      logger.warn(
        { sessionId, predecessorSessionId: predecessorId },
        "Predecessor session not found while building context",
      );
      return null;
    }
    const awaySummary = predecessor.away_summary?.trim();
    const payload = awaySummary
      ? {
          session_id: predecessorId,
          source: "away_summary",
          summary: awaySummary,
        }
      : {
          session_id: predecessorId,
          source: "turn_excerpt",
          ...(await buildSessionTurnExcerpt(db, predecessorId)),
        };
    return {
      key: "predecessor_session_summary",
      label: "이전 세션 요약",
      content: JSON.stringify(payload, null, 2),
    };
  } catch (error) {
    logger.warn(
      { error, sessionId },
      "Failed to build predecessor session context",
    );
    return null;
  }
}
