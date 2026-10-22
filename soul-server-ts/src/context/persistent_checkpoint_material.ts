import type { GenerationCheckpointMaterial } from "@soulstream/mcp-contract";
import type { Logger } from "pino";

import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";
import { PERSISTENT_CHECKPOINT_READ_LIMITS } from "./persistent_checkpoint.js";

export const EMPTY_GENERATION_CHECKPOINT_MATERIAL: GenerationCheckpointMaterial = {
  story: {
    highlight: null,
    narrative: null,
    unfoldedTurnSummaries: [],
    narrativeThroughEventId: null,
    foldCount: 0,
    updatedAt: null,
  },
  lastSummarizedFinalResponseEventId: null,
  recent: { records: [], omittedUnsummarized: 0 },
  childSessions: [],
  childSessionTotal: 0,
  totals: { turnSummaries: 0 },
};

export async function readGenerationCheckpointMaterial(
  db: Pick<SessionDB, "getGenerationCheckpointMaterial">,
  logger: Pick<Logger, "warn">,
  sessionId: string,
): Promise<{ material: GenerationCheckpointMaterial; unavailable: boolean }> {
  let unavailable = false;
  const material = await db
    .getGenerationCheckpointMaterial(sessionId, PERSISTENT_CHECKPOINT_READ_LIMITS)
    .catch((err: unknown) => {
      if (!isSessionDataHostError(err)) throw err;
      unavailable = true;
      logger.warn(
        { err, sessionId },
        "generation checkpoint material unavailable; continuing without history",
      );
      return EMPTY_GENERATION_CHECKPOINT_MATERIAL;
    });
  return { material, unavailable };
}
