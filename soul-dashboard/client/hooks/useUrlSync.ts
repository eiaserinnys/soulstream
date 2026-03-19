/**
 * useUrlSync - URL ↔ 스토어 양방향 동기화
 *
 * 브라우저 주소창과 Zustand activeSessionKey를 동기화합니다.
 * - "/" → 새 대화 (Composer)
 * - "/{agentSessionId}" → 해당 세션 보기
 *
 * React Router를 사용하지 않고 네이티브 History API로 구현합니다.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";

/** pathname에서 세션 ID를 추출합니다. "/" → null, "/sess-abc" → "sess-abc" */
function extractSessionId(pathname: string): string | null {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("/")) return null;
  return trimmed;
}

/** activeSessionKey에 해당하는 pathname을 생성합니다. */
function toPathname(sessionKey: string | null): string {
  return sessionKey ? `/${sessionKey}` : "/";
}

export function useUrlSync() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const startCompose = useDashboardStore((s) => s.startCompose);

  // popstate 핸들러에서 최신 상태를 참조하기 위한 ref
  const skipNextPush = useRef(false);

  // 1. 마운트 시: URL에서 세션 ID 읽어 스토어에 반영
  useEffect(() => {
    const sessionId = extractSessionId(window.location.pathname);
    if (sessionId) {
      // URL에 세션 ID가 있으면 해당 세션 활성화
      skipNextPush.current = true;
      setActiveSession(sessionId);
    }
    // "/" 이면 기본 상태 (Composer) 유지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. activeSessionKey 변경 → URL 업데이트
  useEffect(() => {
    if (skipNextPush.current) {
      skipNextPush.current = false;
      return;
    }

    const targetPath = toPathname(activeSessionKey);
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
  }, [activeSessionKey]);

  // 3. 뒤로가기/앞으로가기 → 스토어 업데이트
  useEffect(() => {
    const handlePopState = () => {
      const sessionId = extractSessionId(window.location.pathname);
      skipNextPush.current = true;
      if (sessionId) {
        setActiveSession(sessionId);
      } else {
        startCompose();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setActiveSession, startCompose]);
}
