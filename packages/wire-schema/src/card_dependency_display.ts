import type { CardStatus } from "../generated/typescript/index.js";

export interface CardDependency {
  id: string; number: number | null; title: string; status: CardStatus; archived: boolean; met: boolean;
}

/** 선행이 더는 풀리지 않는 까닭. 취소됐거나, 충족되지 않은 채 보관됐으면 멈춘 것이다. */
export function cardDependencyStopReason(dep: CardDependency): "cancelled" | "archived" | null {
  if (dep.status === "cancelled") return "cancelled";
  return !dep.met && dep.archived ? "archived" : null;
}

export function cardDependencyDisplay(status: CardStatus, dependencies?: readonly CardDependency[]): {text:string; tone:"neutral"|"error"} | null {
  if (status !== "queued" || !dependencies?.length) return null;
  const stopped = dependencies.find(dep => cardDependencyStopReason(dep));
  const label = (dep: CardDependency) => dep.number == null ? dep.title : `#${dep.number}`;
  if (stopped) return {text:`선행 ${cardDependencyStopReason(stopped) === "cancelled" ? "취소됨" : "보관됨"} ${label(stopped)}`,tone:"error"};
  const waiting = dependencies.filter(dep => !dep.met);
  if (!waiting.length) return null;
  const names = waiting.length > 2 ? `${label(waiting[0]!)} 외 ${waiting.length - 1}건` : waiting.map(label).join(", ");
  return {text:`선행 대기 ${names}`,tone:"neutral"};
}
