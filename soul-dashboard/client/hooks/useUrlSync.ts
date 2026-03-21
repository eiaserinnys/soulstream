/**
 * useUrlSync - URL ↔ 스토어 양방향 동기화
 *
 * 브라우저 주소창과 Zustand activeSessionKey를 동기화합니다.
 * - "/" → 새 대화 (Composer)
 * - "/#/{agentSessionId}" → 해당 세션 보기
 *
 * React Router를 사용하지 않고 네이티브 History API로 구현합니다.
 *
 * 해시 라우팅을 사용하는 이유:
 * 경로 라우팅(/sess-xxx)을 쓰면 탭 URL이 세션 ID로 바뀌어 기본 URL(/)을 식별하기 어렵다.
 * 해시 라우팅(#sess-xxx)은 세션이 활성화되어도 기본 URL이 localhost:PORT/로 유지된다.
 */

import { useEffect, useRef } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";

/** hash에서 세션 ID를 추출합니다. "" → null, "#sess-abc" → "sess-abc" */
function extractSessionId(hash: string): string | null {
  const trimmed = hash.replace(/^#+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("/")) return null;
  return trimmed;
}

export function useUrlSync() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const startCompose = useDashboardStore((s) => s.startCompose);
  const catalog = useDashboardStore((s) => s.catalog);

  // popstate 핸들러에서 최신 상태를 참조하기 위한 ref
  const skipNextPush = useRef(false);

  // 1. 마운트 시: hash에서 세션 ID 읽어 스토어에 반영
  useEffect(() => {
    const sessionId = extractSessionId(window.location.hash);
    if (sessionId) {
      // URL에 세션 ID가 있으면 해당 세션 활성화
      skipNextPush.current = true;
      setActiveSession(sessionId);
    }
    // "/" 이면 기본 상태 (Composer) 유지
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

  // 2. activeSessionKey 변경 → URL 업데이트
  useEffect(() => {
    if (skipNextPush.current) {
      skipNextPush.current = false;
      return;
    }

    if (activeSessionKey) {
      const targetHash = `#${activeSessionKey}`;
      if (window.location.hash !== targetHash) {
        window.history.pushState(null, "", targetHash);
      }
    } else {
      // 세션 없음: hash 제거하여 기본 URL(/)로 복귀
      if (window.location.hash) {
        window.history.pushState(null, "", "/");
      }
    }
  }, [activeSessionKey]);

  // 3. 뒤로가기/앞으로가기 → 스토어 업데이트
  useEffect(() => {
    const handlePopState = () => {
      const sessionId = extractSessionId(window.location.hash);
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
