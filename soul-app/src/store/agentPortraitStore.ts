import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import {
  EMPTY_AGENT_PORTRAIT_DICTIONARY,
  buildAgentPortraitDictionary,
  type AgentPortraitDictionary,
  type AgentPortraitListResponse,
} from '../../../packages/soul-ui/src/lib/agent-portrait';
import { decodeAuthJwt } from '../auth/jwt-payload';
import { createAgentPortraitResolver, type AgentPortraitResolver } from '../lib/agent-portrait-resolver';
import { useAuthStore } from './authStore';
import { useSettingsStore } from './settingsStore';

export const AGENT_PORTRAIT_STORAGE_KEY = 'soul-agent-portraits';
/** 앱이 다시 앞으로 올 때 목록을 다시 받는 최소 간격. */
export const AGENT_PORTRAIT_FOREGROUND_REFRESH_MS = 60_000;

interface StoredPortraits {
  scope: string;
  etag: string | null;
  portraits: AgentPortraitListResponse['portraits'];
}

interface AgentPortraitState {
  dictionary: AgentPortraitDictionary;
  /** 저장한 목록을 읽었거나 첫 응답을 받아 사전이 믿을 만해졌는가. */
  ready: boolean;
  etag: string | null;
  /** 지금 사전이 속한 서버 주소와 사용자. */
  scope: string | null;
  lastAttemptAt: number;
  /** 저장한 목록을 먼저 읽고, 그 뒤 한 번 받는다. 서버 주소나 사용자가 바뀌면 저장한 목록을 버린다. */
  activate(serverUrl: string, jwt: string): Promise<void>;
  /** 로그아웃 등으로 서버나 사용자가 없을 때 메모리의 사전을 비운다. */
  deactivate(): void;
  /** 목록을 받는다. foreground면 마지막 시도로부터 60초가 지나야 한다. */
  refresh(serverUrl: string, jwt: string, reason?: 'start' | 'foreground'): Promise<void>;
}

export function agentPortraitScope(serverUrl: string, jwt: string): string {
  return JSON.stringify([serverUrl.replace(/\/$/, ''), decodeAuthJwt(jwt)?.email ?? '']);
}

const IDLE = {
  dictionary: EMPTY_AGENT_PORTRAIT_DICTIONARY,
  ready: false,
  etag: null,
  scope: null,
  lastAttemptAt: 0,
};

let activation = 0;
let inFlight: Promise<void> | null = null;

async function readStored(): Promise<StoredPortraits | null> {
  try {
    const raw = await AsyncStorage.getItem(AGENT_PORTRAIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPortraits>;
    if (typeof parsed.scope !== 'string' || !Array.isArray(parsed.portraits)) return null;
    return { scope: parsed.scope, etag: typeof parsed.etag === 'string' ? parsed.etag : null, portraits: parsed.portraits };
  } catch {
    return null;
  }
}

export const useAgentPortraitStore = create<AgentPortraitState>()((set, get) => ({
  ...IDLE,

  async activate(serverUrl, jwt) {
    const scope = agentPortraitScope(serverUrl, jwt);
    const turn = ++activation;
    if (get().scope !== scope) {
      inFlight = null;
      set({ ...IDLE, scope });
      const stored = await readStored();
      if (turn !== activation) return;
      if (stored === null) {
        // 저장한 것이 없다.
      } else if (stored.scope !== scope) {
        await AsyncStorage.removeItem(AGENT_PORTRAIT_STORAGE_KEY).catch(() => undefined);
      } else {
        set({ dictionary: buildAgentPortraitDictionary({ portraits: stored.portraits }), etag: stored.etag, ready: true });
      }
    }
    if (turn !== activation) return;
    await get().refresh(serverUrl, jwt, 'start');
  },

  deactivate() {
    activation += 1;
    inFlight = null;
    set({ ...IDLE });
  },

  refresh(serverUrl, jwt, reason = 'start') {
    const scope = agentPortraitScope(serverUrl, jwt);
    const state = get();
    if (state.scope !== scope) return Promise.resolve();
    if (inFlight) return inFlight;
    if (reason === 'foreground' && Date.now() - state.lastAttemptAt < AGENT_PORTRAIT_FOREGROUND_REFRESH_MS) {
      return Promise.resolve();
    }
    set({ lastAttemptAt: Date.now() });
    const current = (async () => {
      try {
        const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/agent-portraits`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            ...(state.etag ? { 'If-None-Match': state.etag } : {}),
          },
        });
        if (get().scope !== scope) return;
        if (response.status === 304) return;
        if (!response.ok) return;
        const body = (await response.json()) as AgentPortraitListResponse;
        if (get().scope !== scope) return;
        const etag = response.headers.get('etag');
        set({ dictionary: buildAgentPortraitDictionary(body), etag, ready: true });
        const stored: StoredPortraits = { scope, etag, portraits: body.portraits ?? [] };
        await AsyncStorage.setItem(AGENT_PORTRAIT_STORAGE_KEY, JSON.stringify(stored)).catch(() => undefined);
      } catch {
        // 받기가 실패하면 지금 사전을 지킨다.
      }
    })();
    inFlight = current;
    void current.finally(() => {
      if (inFlight === current) inFlight = null;
    });
    return current;
  },
}));

/** 초상 주소를 만들거나 바꾸는 규칙. 사전이 바뀌면 이 값도 바뀌어 그림이 다시 그려진다. */
export function useAgentPortraitResolver(): AgentPortraitResolver {
  const dictionary = useAgentPortraitStore((state) => state.dictionary);
  const ready = useAgentPortraitStore((state) => state.ready);
  return useMemo(() => createAgentPortraitResolver(dictionary, ready), [dictionary, ready]);
}

/**
 * 로그인된 상태의 앱 뿌리에 한 번 둔다. 시작 때 저장한 목록을 먼저 쓰고 한 번 받고,
 * 앱이 다시 앞으로 올 때 60초에 한 번까지 다시 받는다.
 */
export function useAgentPortraitSync(): void {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const scope = serverUrl && jwt ? agentPortraitScope(serverUrl, jwt) : null;

  useEffect(() => {
    const store = useAgentPortraitStore.getState();
    if (!serverUrl || !jwt) {
      store.deactivate();
      return;
    }
    void store.activate(serverUrl, jwt);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const latestJwt = useAuthStore.getState().jwt;
      const latestServerUrl = useSettingsStore.getState().serverUrl;
      if (latestJwt && latestServerUrl) {
        void useAgentPortraitStore.getState().refresh(latestServerUrl, latestJwt, 'foreground');
      }
    });
    return () => subscription.remove();
    // jwt가 갱신돼도 같은 사용자면 다시 받지 않는다. scope가 바뀔 때만 다시 시작한다.
  }, [scope]);
}
