import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import { serializeSessionStoryView } from
  "../db/repositories/session_story_repository.js";

import type { ContextItem } from "./prompt_assembler.js";
import { buildSessionTurnExcerpt } from "./session_turn_summary.js";

const LEGACY_TURN_SUMMARY_LIMIT = 30;

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
    const payload = await buildPredecessorPayload(
      db,
      logger,
      sessionId,
      predecessorId,
    );
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

async function buildPredecessorPayload(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  predecessorId: string,
): Promise<Record<string, unknown>> {
  try {
    const story = serializeSessionStoryView(
      await db.getSessionStory(predecessorId),
    );
    if (story.narrative !== null) {
      return {
        session_id: predecessorId,
        source: "session_story",
        narrative: story.narrative,
        unfolded_turn_summaries: story.unfolded_turn_summaries,
      };
    }
    if (story.unfolded_turn_summaries.length > 0) {
      const omittedTurnCount = Math.max(
        0,
        story.unfolded_turn_summaries.length - LEGACY_TURN_SUMMARY_LIMIT,
      );
      return {
        session_id: predecessorId,
        source: "turn_summaries",
        ...(omittedTurnCount > 0
          ? { omitted_turns_notice: `이전 ${omittedTurnCount}턴 생략` }
          : {}),
        unfolded_turn_summaries:
          story.unfolded_turn_summaries.slice(-LEGACY_TURN_SUMMARY_LIMIT),
      };
    }
  } catch (error) {
    logger.warn(
      { error, sessionId, predecessorSessionId: predecessorId },
      "Failed to read predecessor session story; using turn excerpt",
    );
  }
  return {
    session_id: predecessorId,
    source: "turn_excerpt",
    ...(await buildSessionTurnExcerpt(db, predecessorId)),
  };
}
