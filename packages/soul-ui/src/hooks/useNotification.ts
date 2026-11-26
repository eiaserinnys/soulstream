/**
 * useNotification - 브라우저 알림 훅
 *
 * Soul 세션의 주요 이벤트(완료, 에러, 인터벤션 요청)에 대해
 * 브라우저 Notification API를 통해 알림을 표시합니다.
 *
 * 탭이 비활성 상태(document.hidden)일 때만 알림을 표시하여
 * 사용자가 대시보드를 보고 있을 때는 방해하지 않습니다.
 */

import { useEffect, useRef, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { useUiEventTracker } from "../lib/ui-events";

/**
 * 브라우저 알림 권한을 요청하고 이벤트 기반 알림을 관리합니다.
 *
 * @param enabled - 알림 활성화 여부 (기본 true)
 */
export function useNotification(enabled = true) {
  const pendingNotifications = useDashboardStore(
    (s) => s.pendingNotifications,
  );
  const trackUiEvent = useUiEventTracker();

  // 알림 자동 닫기 타이머를 추적 (메모리 누수 방지)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const consumedNoticeIdsRef = useRef<Set<string>>(new Set());

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // 알림 권한 요청
  useEffect(() => {
    if (!enabled) return;
    if (typeof Notification === "undefined") return;

    if (Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, [enabled]);

  /** 브라우저 알림 표시 */
  const showNotification = useCallback(
    (title: string, body: string, tag?: string, source?: { sessionId: string }) => {
      if (!enabled) return;
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;

      // 탭이 활성 상태면 알림 불필요
      if (!document.hidden) return;

      try {
        const notification = new Notification(title, {
          body,
          tag: tag ?? `soul-${Date.now()}`,
          icon: "/favicon.ico",
          silent: false,
        });

        // 알림 클릭 시 탭으로 포커스
        notification.onclick = () => {
          // 사용 로그: 눌렀다는 사실만 남긴다. 이동 동작은 바꾸지 않는다 —
          // 눌렀는데 아무 데도 가지 않았다는 것 자체가 봐야 할 신호다.
          trackUiEvent("notification_open", {
            attrs: { surface: "browser_notification", navigated: false },
            ...(source ? { target: { kind: "session", id: source.sessionId } } : {}),
          });
          window.focus();
          notification.close();
        };

        // 10초 후 자동 닫기 (타이머 추적하여 언마운트 시 정리)
        const timer = setTimeout(() => {
          notification.close();
          timersRef.current.delete(timer);
        }, 10_000);
        timersRef.current.add(timer);
      } catch {
        // Notification 생성 실패 (Service Worker 환경 등)
      }
    },
    [enabled, trackUiEvent],
  );

  // 새 알림 이벤트 감지 → 알림 표시 → 큐 비우기
  useEffect(() => {
    if (!enabled) return;
    if (pendingNotifications.length === 0) return;

    for (const notice of pendingNotifications) {
      if (consumedNoticeIdsRef.current.has(notice.id)) continue;
      consumedNoticeIdsRef.current.add(notice.id);
      showNotification(notice.title, notice.body, `soul-${notice.id}`, {
        sessionId: notice.sessionId,
      });
    }
    while (consumedNoticeIdsRef.current.size > 500) {
      const oldest = consumedNoticeIdsRef.current.values().next().value;
      if (oldest === undefined) break;
      consumedNoticeIdsRef.current.delete(oldest);
    }

    // 처리 완료 후 큐 비우기
    useDashboardStore.setState({ pendingNotifications: [] });
  }, [pendingNotifications, enabled, showNotification]);

  return { showNotification };
}
