import type { GenerationCheckpointMaterial } from "@soulstream/mcp-contract";
import type { Logger } from "pino";
import { readPersistentInstructions } from "@soulstream/wire-schema/persistent-session-instructions";

import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import type { SessionDB } from "../db/session_db.js";
import type { Task } from "../task/task_models.js";
import {
  buildPersistentCheckpoint,
  PERSISTENT_CHECKPOINT_BUDGET,
  PERSISTENT_CHECKPOINT_READ_LIMITS,
  PERSISTENT_SUPERVISION_SCOPE,
} from "./persistent_checkpoint.js";

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

export async function loadPersistentCheckpointContext(
  db: Pick<SessionDB, "getGenerationCheckpointMaterial" | "getSupervisedCardContext">,
  logger: Pick<Logger, "warn">,
  task: Task,
) {
  const sessionId = task.agentSessionId;
  const materialPromise = readGenerationCheckpointMaterial(db, logger, sessionId);
  const cardsPromise = db.getSupervisedCardContext({
    sessionId,
    ...PERSISTENT_SUPERVISION_SCOPE,
    cardLimit: PERSISTENT_CHECKPOINT_BUDGET.cardLimit,
    questionLimit: PERSISTENT_CHECKPOINT_BUDGET.questionLimit,
  });
  const [{ material, unavailable }, cards] = await Promise.all([materialPromise, cardsPromise]);
  return buildPersistentCheckpoint({
    material,
    cards,
    standingInstructions: readPersistentInstructions(task.metadata)
      .filter((instruction) => instruction.status === "active")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((instruction) => instruction.source_turns.length > 0
        ? `- (${instruction.source_turns.join(", ")}) ${instruction.text}`
        : `- ${instruction.text}`),
    ownSessionId: sessionId,
    resetContext: task.activeGenerationRollover?.resetContext === true,
    keepInstructions: task.activeGenerationRollover?.keepInstructions !== false,
    materialUnavailable: unavailable,
  }, PERSISTENT_CHECKPOINT_BUDGET);
}
