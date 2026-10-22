import type { PersistentReportResult } from "@soulstream/wire-schema/persistent-report";
import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";
import type { SessionOwnerResolver } from "../session/session_owner.js";

type CardCreatorActor = { actor_session_id: string | null; actor_user_id: string | null };

/**
 * 카드 질문을 어느 사용자의 판에 올릴지 정한다. 카드를 만든 세션/사용자의 소유 사용자를
 * `카드를 만든 작업 기록 → 세션 소유자` 순서로 푼다. 이 판정은 자동 배정의 발신자 정보와 같은 정본을 쓴다.
 */
export async function resolveCardOwnerEmail(cardId: string, deps: {
  cardCreatorActor: (cardId: string) => Promise<CardCreatorActor | null>;
  findUserByEmail: DashboardUserRepository["findUserByEmail"];
  resolveSessionOwner: SessionOwnerResolver;
}): Promise<string | null> {
  const creator = await deps.cardCreatorActor(cardId);
  if (creator?.actor_user_id) {
    const user = await deps.findUserByEmail(creator.actor_user_id);
    return user?.email ?? null;
  }
  if (creator?.actor_session_id) {
    return (await deps.resolveSessionOwner(creator.actor_session_id))?.ownerEmail ?? null;
  }
  return null;
}

/**
 * 담당이 남긴 카드 질문을 그 카드 소유 사용자의 모든 「지금의 보고」 판에 올린다.
 * 어느 판에 올릴지는 판의 소유자로 다시 판정하고, 이미 답·철회·종료된 질문이나 12장이 찬 판은
 * putQuestion이 조용히 넘긴다(ok:false). 실패를 모아 호출자가 경고만 하며 질문 커밋은 그대로 성공한다.
 */
export async function placeCardQuestionOnOwnerBoards(input: {
  questionId: string;
  ownerEmail: string | null;
  resolveSessionOwner: SessionOwnerResolver;
  listPersistentSessions: () => Promise<readonly { session_id: string; session_type: string | null }[]>;
  putQuestion: (sessionId: string, questionId: string) => Promise<PersistentReportResult>;
}): Promise<{ placed: string[]; failed: string[]; changed: string[] }> {
  if (!input.ownerEmail) return { placed: [], failed: [], changed: [] };
  const placed: string[] = [];
  const failed: string[] = [];
  const changed: string[] = [];
  for (const session of await input.listPersistentSessions()) {
    if (session.session_type === "llm") continue;
    if ((await input.resolveSessionOwner(session.session_id))?.ownerEmail !== input.ownerEmail) continue;
    const result = await input.putQuestion(session.session_id, input.questionId);
    if (result.ok) {
      placed.push(session.session_id);
      if (result.changed) changed.push(session.session_id);
    } else failed.push(session.session_id);
  }
  return { placed, failed, changed };
}
