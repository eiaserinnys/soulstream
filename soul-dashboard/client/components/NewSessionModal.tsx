/**
 * NewSessionModal - 새 세션 생성 모달 (soul-ui 공유 컴포넌트 래퍼)
 *
 * 폴더별 draft 관리와 세션 생성 API 호출을 담당하는 얇은 래퍼.
 * UI 본체는 soul-ui의 NewSessionDialog에 위임한다.
 *
 * 진입 경로(newSessionSource)에 따라 초기 폴더를 다르게 설정한다:
 * - 'feed' 진입: '클로드 코드 세션' 폴더 사전 선택
 * - 'folder' 진입: 현재 선택된 폴더 사전 선택
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useDashboardStore,
  NewSessionDialog,
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  type CreateSessionResponse,
} from "@seosoyoung/soul-ui";

export function NewSessionModal() {
  const isOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeModal = useDashboardStore((s) => s.closeNewSessionModal);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const catalog = useDashboardStore((s) => s.catalog);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);

  // '클로드 코드 세션' 폴더 ID
  const claudeFolder = catalog?.folders.find((f) => f.name === '클로드 코드 세션');

  // 모달이 열릴 때 진입 경로에 따라 초기 폴더 설정
  useEffect(() => {
    if (isOpen) {
      if (newSessionSource === 'feed') {
        setSelectedModalFolderId(claudeFolder?.id ?? null);
      } else {
        setSelectedModalFolderId(selectedFolderId);
      }
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftKey = `__draft__${selectedModalFolderId ?? "null"}`;

  // 선택된 폴더명 계산
  const selectedModalFolderName =
    catalog?.folders.find((f) => f.id === selectedModalFolderId)?.name ??
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
          ...(selectedModalFolderId ? { folderId: selectedModalFolderId } : {}),
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
        selectedModalFolderId,
        result.nodeId,
      );
      closeModal();
    },
    [selectedModalFolderId, addOptimisticSession, clearDraft, draftKey, closeModal],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeModal();
    },
    [closeModal],
  );

  const folderSelector = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Folder</label>
      <Select
        value={selectedModalFolderId ?? ''}
        onValueChange={(v) => setSelectedModalFolderId(v || null)}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a folder..." />
        </SelectTrigger>
        <SelectPopup>
          {catalog?.folders.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );

  return (
    <NewSessionDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      onSubmit={handleSubmit}
      folderSelector={folderSelector}
      subtitle={`in ${selectedModalFolderName}`}
      initialDraft={initialDraft}
      onDraftChange={handleDraftChange}
    />
  );
}
