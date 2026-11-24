/**
 * useAtomPublicUrl - 브라우저에서 열 수 있는 atom 주소(/api/status의 atom_public_url)
 *
 * 페이지마다 /api/status를 한 번 읽어 모듈 수준에 담고, 여러 컴포넌트가 같이 쓴다.
 * 동시에 불러도 요청은 하나다. 창이 다시 보일 때(visibilitychange) 마지막으로 읽은 지
 * 60초가 지났으면 한 번 더 읽는다. 읽지 못하면 이전 값을 유지하고, 처음부터 못 읽었으면 null이다.
 * 폴링은 만들지 않는다.
 */

import { useEffect, useSyncExternalStore } from "react";

const STATUS_URL = "/api/status";
export const ATOM_PUBLIC_URL_REFRESH_MS = 60_000;

/** /api/status 응답의 atom_public_url 해석. http(s) 절대 주소만 받고 끝의 `/`는 뗀다. */
export function parseAtomPublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

let currentValue: string | null = null;
let lastReadAt: number | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setValue(next: string | null): void {
  if (next === currentValue) return;
  currentValue = next;
  for (const listener of [...listeners]) listener();
}

/** 이미 읽는 중이면 그 요청을 같이 기다린다. 실패하면 이전 값을 유지한다. */
export function loadAtomPublicUrl(): Promise<void> {
  if (inflight) return inflight;
  lastReadAt = Date.now();
  inflight = (async () => {
    try {
      const res = await fetch(STATUS_URL);
      if (!res.ok) return;
      const data = (await res.json()) as { atom_public_url?: unknown } | null;
      setValue(parseAtomPublicUrl(data?.atom_public_url));
    } catch {
      // 이전 값을 유지한다.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function refreshIfStale(): void {
  if (inflight) return;
  if (lastReadAt !== null && Date.now() - lastReadAt < ATOM_PUBLIC_URL_REFRESH_MS) return;
  void loadAtomPublicUrl();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return currentValue;
}

export function useAtomPublicUrl(): string | null {
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (lastReadAt === null) void loadAtomPublicUrl();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return value;
}

/** 시험 전용: 모듈 상태를 처음으로 되돌린다. */
export function resetAtomPublicUrlForTests(): void {
  currentValue = null;
  lastReadAt = null;
  inflight = null;
  listeners.clear();
}
