/**
 * EventStore — 세션 이벤트 in-memory 캐시.
 * 세션 종료 후에도 이벤트를 replay할 수 있도록 저장한다.
 */

import type { SessionEvent } from "./types";

export class EventStore {
  private _store = new Map<string, SessionEvent[]>();
  private readonly MAX_EVENTS_PER_SESSION = 2000;

  append(sessionId: string, event: SessionEvent): void {
    const list = this._store.get(sessionId) ?? [];
    list.push(event);
    if (list.length > this.MAX_EVENTS_PER_SESSION) list.shift(); // oldest 제거
    this._store.set(sessionId, list);
  }

  getEvents(sessionId: string): SessionEvent[] {
    return this._store.get(sessionId) ?? [];
  }

  clear(sessionId: string): void {
    this._store.delete(sessionId);
  }

  get size(): number {
    return this._store.size;
  }
}

export const globalEventStore = new EventStore();
