import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  NOOP_UI_EVENT_COLLECTOR,
  type UiEventCollector,
  type UiEventDraft,
  type UiEventEntry,
  type UiEventType,
} from "./collector";
import { startBrowserUiEventCollector } from "./browser-collector";

// 진입경로 힌트는 React 와 무관한 순수 헬퍼라 코어에 산다. 여기서는 다시 내보내기만 한다.
export { createUiEventEntryHint } from "./collector";
export type { UiEventEntryHint } from "./collector";

/**
 * 기본값이 no-op이라 Provider 없이 렌더되는 컴포넌트·테스트도 그대로 돈다.
 * 계측이 화면을 망가뜨릴 수 없다는 보장을 타입이 아니라 기본값으로 건다.
 */
const UiEventsContext = createContext<UiEventCollector>(NOOP_UI_EVENT_COLLECTOR);

export function useUiEvents(): UiEventCollector {
  return useContext(UiEventsContext);
}

export type UiEventsProviderProps = {
  /** 로그인 전에는 `null`. 사용자가 정해져야 수집을 시작한다. */
  readonly userEmail: string | null;
  readonly appVersion: string;
  readonly children: ReactNode;
};

export function UiEventsProvider(props: UiEventsProviderProps) {
  const [collector, setCollector] = useState<UiEventCollector>(NOOP_UI_EVENT_COLLECTOR);

  useEffect(() => {
    if (props.userEmail === null) {
      // 로그아웃 상태에서는 수집기를 두지 않는다.
      setCollector(NOOP_UI_EVENT_COLLECTOR);
      return;
    }
    if (typeof window === "undefined") return;
    const started = startBrowserUiEventCollector({
      userEmail: props.userEmail,
      appVersion: props.appVersion,
      onWarning: (message, error) => console.warn(message, error),
    });
    setCollector(started.collector);
    return () => {
      // 이 effect 는 userEmail 이 바뀔 때만 다시 돈다 — 로그아웃이거나 사용자 전환이다.
      // 어느 쪽이든 보내지 않은 대기열을 남겨 두면 안 된다. 언로드로 끝나는 경우는
      // pagehide 가 먼저 beacon 으로 내보낸다.
      started.dispose({ discardPendingQueue: true });
      setCollector(NOOP_UI_EVENT_COLLECTOR);
    };
  }, [props.userEmail, props.appVersion]);

  return (
    <UiEventsContext.Provider value={collector}>
      {props.children}
    </UiEventsContext.Provider>
  );
}

/** React 바깥(스토어 구독 등)에서 쓰는 호출 형태를 한 군데로 모은다. */
export type UiEventTracker = (type: UiEventType, draft?: UiEventDraft) => void;

export function useUiEventTracker(): UiEventTracker {
  const collector = useUiEvents();
  const ref = useRef(collector);
  ref.current = collector;
  return useMemo(() => (type, draft) => ref.current.track(type, draft), []);
}

/** 네비게이션을 일으키는 클릭 자리에서 진입경로를 찍기 위한 훅. */
export function useUiEventEntryMarker(): (entry: UiEventEntry) => void {
  const collector = useUiEvents();
  const ref = useRef(collector);
  ref.current = collector;
  return useMemo(() => (entry: UiEventEntry) => ref.current.markEntry(entry), []);
}
