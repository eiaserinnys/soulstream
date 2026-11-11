import type { CardRow, FolderActorParams } from "./control_plane/card_types.js";

type QuestionState = { answer: string | null; withdrawn_at: Date | null };

/** Answer eligibility belongs to the question record, including after the card ends. */
export function cardQuestionState(question: QuestionState | undefined): "missing" | "open" | "answered" | "withdrawn" {
  if (!question) return "missing";
  if (question.withdrawn_at !== null) return "withdrawn";
  return question.answer === null ? "open" : "answered";
}

/** Withdrawal grants no other card mutation rights. */
export function canWithdrawCardQuestion(
  card: Pick<CardRow, "assignee_kind" | "assignee_session_id">,
  question: { session_id: string | null } | undefined,
  actor: FolderActorParams,
): boolean {
  return actor.actorKind === "agent" && Boolean(actor.actorSessionId)
    && (question?.session_id === actor.actorSessionId
      || (card.assignee_kind === "session" && card.assignee_session_id === actor.actorSessionId));
}
