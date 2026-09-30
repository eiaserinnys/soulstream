import type { CardAssignment, CardRow } from "./card-types";
export class CardApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function cardRequest<T>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new CardApiError(payload?.detail?.error?.message ?? payload?.message ?? `카드 요청 실패 (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}
export function createCardInput(request: string, selection: CardAssignment, idempotencyKey: string) {
  return { folderId: selection.folderId, title: request.trim().split(/\r?\n/)[0].slice(0, 60), request,
    assignee: { kind: "agent" as const, agentId: selection.agentId }, nodeId: selection.nodeId,
    modelPreset: selection.modelPreset || null, queue: true, idempotencyKey };
}
export function groupCards<T extends { status: string; archived?: boolean; queuePositionKey?: string | null }>(cards: readonly T[]) {
  const visible = cards.filter(c => !c.archived);
  return { attention: visible.filter(c => c.status === "review" || c.status === "blocked"),
    running: visible.filter(c => c.status === "running"),
    queued: visible.filter(c => c.status === "queued").sort((a,b) => (a.queuePositionKey ?? "") < (b.queuePositionKey ?? "") ? -1 : (a.queuePositionKey ?? "") > (b.queuePositionKey ?? "") ? 1 : 0) };
}
export function queueAfterId(ids: readonly string[], movedId: string) { return ids[ids.indexOf(movedId) - 1] ?? null; }
export const cardPath = (id: string) => `/api/cards/${encodeURIComponent(id)}`;
export const cardMutationKey = () => `card-web:${crypto.randomUUID()}`;
export async function fetchCards(folderId: string): Promise<CardRow[]> {
  return (await cardRequest<{cards: CardRow[]}>(`/api/cards?${new URLSearchParams({folderId})}`)).cards;
}
