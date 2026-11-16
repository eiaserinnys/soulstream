import type { ClaudeAccount } from "@seosoyoung/soul-ui";

export type PriorityPatch = { id: string; priority: number };

export type PriorityMovePlan = {
  /** 화면에 보일 원하는 순서. 모든 계정의 priority 가 1..N 으로 정리돼 있다. */
  accounts: ClaudeAccount[];
  /** 지금 값과 다른 계정만 담는다. */
  patches: PriorityPatch[];
};

/**
 * 화면 순서에서 index 의 계정을 direction 만큼 옮긴 뒤 모든 계정의 priority 를 1..N 으로 정리한다.
 * 화살표 이동은 활성 계정 사이에서만 일어난다. 옮길 수 없으면 null.
 */
export function planPriorityMove(
  orderedAccounts: readonly ClaudeAccount[],
  index: number,
  direction: -1 | 1,
): PriorityMovePlan | null {
  const destination = index + direction;
  const moving = orderedAccounts[index];
  const neighbor = orderedAccounts[destination];
  if (!moving?.enabled || !neighbor?.enabled) return null;
  const desired = [...orderedAccounts];
  desired[index] = neighbor;
  desired[destination] = moving;
  const accounts = desired.map((account, position) => ({ ...account, priority: position + 1 }));
  const patches = accounts
    .map((account, position) => ({ id: account.id, priority: position + 1, current: desired[position]?.priority ?? null }))
    .filter((entry) => entry.current !== entry.priority)
    .map(({ id, priority }) => ({ id, priority }));
  return { accounts, patches };
}
