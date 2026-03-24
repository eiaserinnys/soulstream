/**
 * NewSessionModal - 새 세션 생성 모달 (soul-ui 공유 컴포넌트 래퍼)
 *
 * 폴더별 draft 관리와 세션 생성 API 호출을 담당하는 얇은 래퍼.
 * UI 본체는 soul-ui의 NewSessionDialog에 위임한다.
 */

import { useCallback, useMemo } from "react";
import {
  useDashboardStore,
  NewSessionDialog,
  type CreateSessionResponse,
} from "@seosoyoung/soul-ui";

export function NewSessionModal() {
  const isOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeModal = useDashboardStore((s) => s.closeNewSessionModal);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  const draftKey = `__draft__${selectedFolderId ?? "null"}`;

  // 폴더명 계산
  const folderName =
    catalog?.folders.find((f) => f.id === selectedFolderId)?.name ??
    "Claude Code";

  // 현재 draft 복원
  const initialDraft = useMemo(() => {
    return useDashboardStore.getState().drafts[draftKey] ?? "";
  }, [draftKey, isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(draftKey, value);
    },
    [draftKey, setDraft],
  );

  const handleSubmit = useCallback(
    async (prompt: string) => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: { message: "Unknown error" } }));
        throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      }

      const result: CreateSessionResponse = await response.json();

      // 성공: draft 삭제, 낙관적 추가, 모달 닫기
      clearDraft(draftKey);
      addOptimisticSession(
        result.agentSessionId,
        prompt,
        selectedFolderId,
        result.nodeId,
      );
      closeModal();
    },
    [selectedFolderId, addOptimisticSession, clearDraft, draftKey, closeModal],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeModal();
    },
    [closeModal],
  );

  return (
    <NewSessionDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      onSubmit={handleSubmit}
      subtitle={`in ${folderName}`}
      initialDraft={initialDraft}
      onDraftChange={handleDraftChange}
    />
  );
}
