import type { Logger } from "pino";

import type { SessionTurnExcerptResult } from
  "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";

import type { FollowupContext } from "./context_builder.js";

export const CLAUDE_ROLLOVER_HISTORY_MAX_CHARS = 12_000;

export interface BackendRolloverContext extends FollowupContext {
  currentSessionExcerpt?: SessionTurnExcerptResult;
  /** transcript_missing 롤오버에서 turn excerpt 대신 싣는 세션 스토리. */
  sessionStory?: string;
}

export async function buildBestEffortBackendRolloverContext(input: {
  db: SessionDB;
  logger: Logger;
  sessionId: string;
  buildFullContext: () => Promise<FollowupContext>;
  /**
   * 있으면 turn excerpt 대신 세션 스토리를 싣는다(transcript_missing).
   * 실패하면 excerpt로 한 번 더 내려간다.
   */
  loadSessionStory?: () => Promise<string>;
}): Promise<BackendRolloverContext> {
  const [contextResult, historyResult] = await Promise.allSettled([
    input.buildFullContext(),
    input.loadSessionStory !== undefined
      ? input.loadSessionStory().then((story) => ({ story }))
      : input.db.getTurnExcerpt(input.sessionId, CLAUDE_ROLLOVER_HISTORY_MAX_CHARS)
        .then((excerpt) => ({ excerpt })),
  ]);
  if (contextResult.status === "rejected") {
    input.logger.warn(
      { err: contextResult.reason, sessionId: input.sessionId },
      "Backend rollover full context unavailable; continuing with bounded history",
    );
  }
  const context = contextResult.status === "fulfilled"
    ? contextResult.value
    : { contextItems: [] };
  if (historyResult.status === "fulfilled") {
    return "story" in historyResult.value
      ? { ...context, sessionStory: historyResult.value.story }
      : { ...context, currentSessionExcerpt: historyResult.value.excerpt };
  }
  if (input.loadSessionStory === undefined) {
    input.logger.warn(
      { err: historyResult.reason, sessionId: input.sessionId },
      "Backend rollover history unavailable; continuing with metadata-only notice",
    );
    return context;
  }
  input.logger.warn(
    { err: historyResult.reason, sessionId: input.sessionId },
    "Backend rollover session story unavailable; falling back to turn excerpt",
  );
  const excerpt = await input.db
    .getTurnExcerpt(input.sessionId, CLAUDE_ROLLOVER_HISTORY_MAX_CHARS)
    .catch((err: unknown) => {
      input.logger.warn(
        { err, sessionId: input.sessionId },
        "Backend rollover history unavailable; continuing with metadata-only notice",
      );
      return undefined;
    });
  return excerpt === undefined ? context : { ...context, currentSessionExcerpt: excerpt };
}
