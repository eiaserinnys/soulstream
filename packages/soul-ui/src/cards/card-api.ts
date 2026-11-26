import {orchestratorFetch} from "../lib/orchestrator-connection";
import type { CardAssignment, CardRow } from "./card-types";
export class CardApiError extends Error { constructor(message: string, readonly status: number, readonly code?:string) { super(message); } }
async function sendCardRequest<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await orchestratorFetch(fetch,path, { method, credentials: "same-origin", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new CardApiError(payload?.detail?.error?.message ?? payload?.message ?? `카드 요청 실패 (${response.status})`, response.status,payload?.detail?.error?.code);
  }
  return response.json() as Promise<T>;
}

type ListWaiter = { resolve(value: unknown): void; reject(reason: unknown): void };
type ListLane = { running: boolean; scheduled: boolean; waiters: Set<ListWaiter> };
const listLanes = new Map<string, ListLane>();
const isCardListRead = (path: string, method: string, body?: object) =>
  method === "GET" && !body && (path === "/api/cards" || path.startsWith("/api/cards?"));

/** 목록 요청은 URL마다 한 줄로 세운다. 진행 중 요청이 있으면 그것이 끝난 뒤 시작할 다음 요청 하나를 그동안 들어온 호출이 함께 기다리므로, 모든 호출은 자기 호출 뒤에 시작한 요청의 응답을 받는다. */
function runListLane(path: string, lane: ListLane) {
  lane.scheduled = false;
  if (lane.waiters.size === 0) { listLanes.delete(path); return; }
  lane.running = true;
  const batch = [...lane.waiters];
  lane.waiters.clear();
  sendCardRequest<unknown>(path, "GET").then(
    value => batch.forEach(waiter => waiter.resolve(structuredClone(value))),
    failure => batch.forEach(waiter => waiter.reject(failure)),
  ).finally(() => { lane.running = false; runListLane(path, lane); });
}

/** abort는 그 호출의 기다림만 끊는다. 합쳐진 요청 자체는 다른 호출이 기다리므로 끊지 않는다. */
function coalescedListRead<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let lane = listLanes.get(path);
  if (!lane) { lane = { running: false, scheduled: false, waiters: new Set() }; listLanes.set(path, lane); }
  const joined = lane;
  return new Promise<T>((resolve, reject) => {
    const waiter: ListWaiter = {
      resolve: value => { signal?.removeEventListener("abort", onAbort); resolve(value as T); },
      reject: reason => { signal?.removeEventListener("abort", onAbort); reject(reason); },
    };
    const onAbort = () => { joined.waiters.delete(waiter); waiter.reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    joined.waiters.add(waiter);
    if (!joined.running && !joined.scheduled) { joined.scheduled = true; queueMicrotask(() => runListLane(path, joined)); }
  });
}

export function cardRequest<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  return isCardListRead(path, method, body) ? coalescedListRead<T>(path, signal) : sendCardRequest<T>(path, method, body, signal);
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
/** 카드 #1197 화면 계약 2절: 질문 답은 선택과 글 두 꼴이고 idempotencyKey는 보내는 쪽이 더한다. */
export type CardQuestionAnswerRequest = { mode: "choice"; option: string } | { mode: "text"; answer: string };
/** 카드 #1197 화면 계약 2절: 되묻기와 덧붙이기는 질문에 묶인 커멘트다. */
export type CardQuestionCommentRequest = { questionId: string; body: string };
export const cardQuestionChoiceAnswer = (option: string): CardQuestionAnswerRequest => ({ mode: "choice", option });
export const cardQuestionTextAnswer = (answer: string): CardQuestionAnswerRequest => ({ mode: "text", answer });
export function confirmCardItem(cardId: string, itemId: number, confirmed: boolean): Promise<{card:CardRow}> {
  return cardRequest<{card:CardRow}>(`${cardPath(cardId)}/items/${encodeURIComponent(String(itemId))}/confirm`, "POST", {confirmed});
}
export async function fetchCards(folderId: string): Promise<CardRow[]> {
  return (await cardRequest<{cards: CardRow[]}>(`/api/cards?${new URLSearchParams({folderId})}`)).cards;
}
