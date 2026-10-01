import type { CardStatus, FolderOperationActorKind, CardRow } from "./control_plane/card_types.js";

export function assertCardTransition(
  from: CardStatus, to: CardStatus, actor: FolderOperationActorKind,
  reportCount: number, blockedKind: CardRow["blocked_kind"],
): void {
  const reject=(message: string): never => { throw Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_TRANSITION" }); };
  if (to === "done" && actor !== "user") reject("Only a human may complete a card");
  if (to === "review" && reportCount === 0) reject("Review requires a report");
  if (to === "blocked" && !blockedKind) reject("Blocked cards require a kind");
  if (actor === "agent" || actor === "llm") {
    const review = to === "review" && from !== "done" && from !== "cancelled";
    const question = from === "running" && to === "blocked" && blockedKind === "question";
    if (!review && !question) {
      reject("Agents may only request review of nonterminal cards or block running cards with a question");
    }
  }
}
