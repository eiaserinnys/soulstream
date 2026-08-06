import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import {
  isSessionDataHostError,
  SessionDataHostError,
  type SessionResumeContext,
} from "../control_plane/session_data_host_client.js";
import { serializeSessionStoryView } from
  "../db/session_story_types.js";

import type { ContextItem } from "./prompt_assembler.js";

const LEGACY_TURN_SUMMARY_LIMIT = 30;

export async function buildPredecessorSummaryContextItem(
  db: SessionDB,
  logger: Logger,
  sessionId: string,
  preloaded?: SessionResumeContext["predecessor"],
): Promise<ContextItem | null> {
  try {
    const predecessor = preloaded === undefined
      ? await loadPredecessor(db, sessionId)
      : preloaded;
    if (!predecessor) return null;
    const predecessorId = predecessor.session.session_id;
    const payload = buildPredecessorPayload(predecessorId, predecessor);
    return {
      key: "predecessor_session_summary",
      label: "이전 세션 요약",
      content: JSON.stringify(payload, null, 2),
    };
  } catch (error) {
    if (isSessionDataHostError(error)) throw error;
    logger.warn(
      { error, sessionId },
      "Failed to build predecessor session context",
    );
    return null;
  }
}

async function loadPredecessor(
  db: SessionDB,
  sessionId: string,
): Promise<SessionResumeContext["predecessor"]> {
  const resume = await db.getResumeContext(sessionId, LEGACY_TURN_SUMMARY_LIMIT);
  return resume.predecessor;
}

function buildPredecessorPayload(
  predecessorId: string,
  predecessor: NonNullable<SessionResumeContext["predecessor"]>,
): Record<string, unknown> {
  const story = serializeSessionStoryView(predecessor.story);
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
  if (!predecessor.excerpt) {
    throw new SessionDataHostError({
      operation: "resume_context",
      retryable: false,
      message: "resume context omitted the predecessor history excerpt",
    });
  }
  return {
    session_id: predecessorId,
    source: "turn_excerpt",
    ...predecessor.excerpt,
  };
}
