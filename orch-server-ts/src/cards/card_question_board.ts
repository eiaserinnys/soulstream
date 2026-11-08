import type { DashboardUserRepository } from "../runtime/live_dashboard_access_provider.js";
import type { SessionOwnerResolver } from "../session/session_owner.js";

type CardCreatorActor = { actor_session_id: string | null; actor_user_id: string | null };

/**
 * 카드의 소유 사용자를 정한다. 카드를 만든 세션/사용자의 소유 사용자를
 * `카드를 만든 작업 기록 → 세션 소유자` 순서로 푼다. 카드 질문 휴대폰 알림의 수신자를 이 정본으로 정하고,
 * 자동 배정의 발신자 정보도 같은 정본을 쓴다.
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
