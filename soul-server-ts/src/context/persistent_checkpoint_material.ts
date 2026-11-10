import type { GenerationCheckpointMaterial, SupervisedCardSnapshot } from "@soulstream/mcp-contract";
import type { Logger } from "pino";
import { readPersistentInstructions } from "@soulstream/wire-schema/persistent-session-instructions";

import { isSessionDataHostError } from "../control_plane/session_data_host_client.js";
import type { AssignedCardContext } from "./assigned_card_context.js";
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
  db: Pick<
    SessionDB,
    "getGenerationCheckpointMaterial" | "getSupervisedCardContext" | "getAssignedCardContext"
  >,
  logger: Pick<Logger, "warn">,
  task: Task,
) {
  const sessionId = task.agentSessionId;
  const materialPromise = readGenerationCheckpointMaterial(db, logger, sessionId);
  // PAS는 감독 범위(전체 폴더)를 보지만, 일반 세션은 그 세션 자신의 담당 카드만 본다.
  const cardsPromise = task.persistent === true
    ? db.getSupervisedCardContext({
        sessionId,
        ...PERSISTENT_SUPERVISION_SCOPE,
        cardLimit: PERSISTENT_CHECKPOINT_BUDGET.cardLimit,
        questionLimit: PERSISTENT_CHECKPOINT_BUDGET.questionLimit,
      })
    : db.getAssignedCardContext(sessionId).then(assignedCardSnapshot);
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

/** 일반 세션 자신의 담당 카드 스냅샷을 감독 스냅샷 모양으로 옮긴다. */
export function assignedCardSnapshot(source: AssignedCardContext): SupervisedCardSnapshot {
  const counts = { running: 0, blocked: 0, review: 0, queued: 0, todo: 0 };
  const cards: SupervisedCardSnapshot["cards"][number][] = [];
  for (const card of source.cards) {
    if (card.status === "todo") {
      counts.todo += 1;
      continue;
    }
    if (
      card.status !== "running"
      && card.status !== "blocked"
      && card.status !== "review"
      && card.status !== "queued"
    ) {
      continue;
    }
    counts[card.status] += 1;
    cards.push({
      id: card.id,
      title: card.title,
      status: card.status,
      blockedKind: null,
      assignee: { kind: null, agentId: null, sessionId: null },
    });
  }
  return {
    capturedAt: source.capturedAt,
    counts,
    cards,
    openQuestions: [],
    openQuestionTotal: 0,
  };
}
