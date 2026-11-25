import { useCallback } from "react";
import { create } from "zustand";

import {
  EMPTY_AGENT_PORTRAIT_DICTIONARY,
  agentPortraitUrl,
  buildAgentPortraitDictionary,
  type AgentPortraitDictionary,
  type AgentPortraitListResponse,
} from "../lib/agent-portrait";

/** 창이 다시 보일 때 목록을 다시 받는 최소 간격. */
export const AGENT_PORTRAIT_REFRESH_INTERVAL_MS = 60_000;

interface AgentPortraitState {
  dictionary: AgentPortraitDictionary;
  /** 첫 목록을 받기 전에는 false. 이때는 서버가 준 주소를 그대로 쓴다. */
  loaded: boolean;
  etag: string | null;
  lastFetchedAt: number;
  /** 목록을 받는다. 받은 ETag로 조건부 요청을 하고 304면 그대로 둔다. */
  refresh(): Promise<void>;
}

export const useAgentPortraitStore = create<AgentPortraitState>((set, get) => ({
  dictionary: EMPTY_AGENT_PORTRAIT_DICTIONARY,
  loaded: false,
  etag: null,
  lastFetchedAt: 0,
  async refresh() {
    set({ lastFetchedAt: Date.now() });
    try {
      const etag = get().etag;
      const response = await fetch("/api/agent-portraits", {
        credentials: "same-origin",
        ...(etag === null ? {} : { headers: { "If-None-Match": etag } }),
      });
      if (response.status === 304) {
        set({ loaded: true });
        return;
      }
      if (!response.ok) return;
      const body = (await response.json()) as AgentPortraitListResponse;
      set({
        dictionary: buildAgentPortraitDictionary(body),
        loaded: true,
        etag: response.headers.get("ETag"),
      });
    } catch {
      // 목록을 못 받으면 서버가 준 주소로 계속 그린다. 다음 기회에 다시 받는다.
    }
  },
}));

/**
 * 첫 화면에서 목록을 받고, 창이 다시 보일 때(60초에 한 번까지) 다시 받는다.
 * 설정창에서 초상을 올리거나 지운 직후에는 useAgentPortraitStore.getState().refresh()를 직접 부른다.
 */
export function startAgentPortraitSync(): () => void {
  void useAgentPortraitStore.getState().refresh();
  if (typeof document === "undefined") return () => undefined;
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    const { lastFetchedAt, refresh } = useAgentPortraitStore.getState();
    if (Date.now() - lastFetchedAt >= AGENT_PORTRAIT_REFRESH_INTERVAL_MS) void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/** 사전이 로드됐을 때만 사전을 돌려준다. 로드 전에는 null. */
export function useAgentPortraitDictionary(): AgentPortraitDictionary | null {
  return useAgentPortraitStore((state) => (state.loaded ? state.dictionary : null));
}

/**
 * 에이전트 id로 초상 주소를 만드는 함수. 목록을 받은 뒤에는 버전 주소(없으면 빈 문자열)이고,
 * 받기 전에는 버전 없는 중앙 주소를 돌려줘 첫 화면에서 대체 표시가 깜박이지 않게 한다.
 */
export function useAgentPortraitUrlResolver(): (agentId: string | null | undefined) => string {
  const dictionary = useAgentPortraitDictionary();
  return useCallback(
    (agentId) => {
      if (!agentId) return "";
      return dictionary === null
        ? `/api/agent-portraits/${encodeURIComponent(agentId)}`
        : agentPortraitUrl(agentId, dictionary);
    },
    [dictionary],
  );
}
