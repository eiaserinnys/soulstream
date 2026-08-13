import type { Logger } from "pino";

import type { SessionTurnExcerptResult } from
  "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";

import type { FollowupContext } from "./context_builder.js";

export const CLAUDE_ROLLOVER_HISTORY_MAX_CHARS = 12_000;

export interface BackendRolloverContext extends FollowupContext {
  currentSessionExcerpt?: SessionTurnExcerptResult;
}

export async function buildBestEffortBackendRolloverContext(input: {
  db: SessionDB;
  logger: Logger;
  sessionId: string;
  buildFullContext: () => Promise<FollowupContext>;
}): Promise<BackendRolloverContext> {
  const [contextResult, excerptResult] = await Promise.allSettled([
    input.buildFullContext(),
    input.db.getTurnExcerpt(input.sessionId, CLAUDE_ROLLOVER_HISTORY_MAX_CHARS),
  ]);
  if (contextResult.status === "rejected") {
    input.logger.warn(
      { err: contextResult.reason, sessionId: input.sessionId },
      "Backend rollover full context unavailable; continuing with bounded history",
    );
  }
  if (excerptResult.status === "rejected") {
    input.logger.warn(
      { err: excerptResult.reason, sessionId: input.sessionId },
      "Backend rollover history unavailable; continuing with metadata-only notice",
    );
  }
  const context = contextResult.status === "fulfilled"
    ? contextResult.value
    : { contextItems: [] };
  return {
    ...context,
    ...(excerptResult.status === "fulfilled"
      ? { currentSessionExcerpt: excerptResult.value }
      : {}),
  };
}
