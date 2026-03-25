/**
 * useUrlSync - URL ↔ 스토어 양방향 동기화
 *
 * URL 해시 라우팅으로 뷰 모드와 활성 세션을 동기화합니다.
 *
 * URL 패턴:
 *   /#/feed                  → 피드 뷰, 세션 미선택
 *   /#/feed/{agentSessionId} → 피드 뷰 + 해당 세션 선택
 *   /#/{agentSessionId}      → 폴더 뷰 + 해당 세션 선택
 *   /#/ 또는 /               → 피드 뷰 (초기 진입)
 *
 * React Router를 사용하지 않고 네이티브 History API로 구현합니다.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "../stores/dashboard-store";

interface ParsedHash {
  viewMode: "feed" | "folder";
  sessionId: string | null;
}

/** URL 해시를 파싱하여 viewMode + sessionId를 추출한다 */
function parseHash(hash: string): ParsedHash {
  // '#/feed/sess-xxx' → 'feed/sess-xxx', '#sess-xxx' → 'sess-xxx', '' → ''
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");

  if (!path || path === "feed") {
    return { viewMode: "feed", sessionId: null };
  }
  if (path.startsWith("feed/")) {
    return { viewMode: "feed", sessionId: path.slice(5) || null };
  }
  return { viewMode: "folder", sessionId: path };
}

/** viewMode + sessionId로 해시 문자열을 생성한다 */
function buildHash(viewMode: "feed" | "folder", sessionId: string | null): string {
  if (viewMode === "feed") {
    return sessionId ? `#feed/${sessionId}` : "#feed";
  }
  return sessionId ? `#${sessionId}` : "";
}

export function useUrlSync() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const clearActiveSession = useDashboardStore((s) => s.clearActiveSession);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const catalog = useDashboardStore((s) => s.catalog);

  // URL에서 스토어 갱신 중일 때 스토어→URL 역방향 push를 억제
  const skipNextPush = useRef(false);

  // 1. 마운트 시: 해시에서 뷰 모드 + 세션 ID를 읽어 스토어에 반영
  useEffect(() => {
    const { viewMode: parsedMode, sessionId } = parseHash(window.location.hash);
    skipNextPush.current = true;
    setViewMode(parsedMode);
    if (sessionId) {
      setActiveSession(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1-2. catalog 로드 후 폴더 재동기화 (1회성)
  // 마운트 시 setActiveSession이 catalog 없이 실행됐으면 selectedFolderId가
  // null(미분류)로 잘못 설정되었을 수 있다. catalog 최초 로드 시 실제 폴더를 재확인한다.
  const folderSyncDone = useRef(false);
  useEffect(() => {
    if (folderSyncDone.current) return;
    if (!activeSessionKey || !catalog?.sessions) return;
    const entry = catalog.sessions[activeSessionKey];
    const correctFolderId = entry?.folderId ?? null;
    const { selectedFolderId } = useDashboardStore.getState();
    if (selectedFolderId !== correctFolderId) {
      useDashboardStore.setState({ selectedFolderId: correctFolderId });
    }
    folderSyncDone.current = true;
  }, [activeSessionKey, catalog]);

  // 2. 스토어 변경 → URL 해시 업데이트
  useEffect(() => {
    if (skipNextPush.current) {
      skipNextPush.current = false;
      return;
    }

    const targetHash = buildHash(viewMode, activeSessionKey);
    const currentHash = window.location.hash;

    // 같은 해시면 무시
    if (currentHash === targetHash || (!currentHash && !targetHash)) return;

    if (targetHash) {
      window.history.pushState(null, "", targetHash);
    } else {
      window.history.pushState(null, "", "/");
    }
  }, [activeSessionKey, viewMode]);

  // 3. 뒤로가기/앞으로가기 (popstate) → 스토어 업데이트
  useEffect(() => {
    const handlePopState = () => {
      const { viewMode: parsedMode, sessionId } = parseHash(window.location.hash);
      skipNextPush.current = true;
      setViewMode(parsedMode);
      if (sessionId) {
        setActiveSession(sessionId);
      } else {
        clearActiveSession();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setActiveSession, clearActiveSession, setViewMode]);
}
