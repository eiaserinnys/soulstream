import type { CardDependency } from "./card_dependencies.js";

export type DependencyWaiter = { id: string; number: number | null; assignee_session_id: string; dependencies: readonly CardDependency[] };
export type DependencyReleaseNotice = { sessionId: string; deliveryId: string; text: string };

const label = (card: { id: string; number: number | null }) => card.number === null ? card.id : `#${card.number}`;

/** One notice per started card whose predecessors are all met now; a card still waiting for another predecessor gets none. */
export function buildDependencyReleaseNotices(waiters: readonly DependencyWaiter[]): DependencyReleaseNotice[] {
  return waiters.filter(waiter => waiter.dependencies.length > 0 && waiter.dependencies.every(dependency => dependency.met)).map(waiter => {
    const ids = waiter.dependencies.map(dependency => dependency.id).sort().join(",");
    const names = [...waiter.dependencies].sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.id.localeCompare(b.id)).map(label).join(", ");
    return {
      sessionId: waiter.assignee_session_id,
      deliveryId: `card-dependencies-met:${waiter.id}:${ids}`,
      text: `[선행 카드 완료] 카드 ${label(waiter)}이 기다리던 선행 카드 ${names}가 모두 끝났습니다. get_card로 선행의 결과를 읽고, 이 카드를 막힘으로 두었으면 진행 중으로 옮긴 뒤 이어 가세요.`,
    };
  });
}
