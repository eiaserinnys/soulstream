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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useDashboardStore,
  NewSessionDialog,
  Select,
  SelectTrigger,
  SelectPopup,
  SelectItem,
  cn,
  type CreateSessionResponse,
  type DashboardAgentConfig,
} from "@seosoyoung/soul-ui";

export function NewSessionModal() {
  const isOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeModal = useDashboardStore((s) => s.closeNewSessionModal);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const catalog = useDashboardStore((s) => s.catalog);
  const dashboardConfig = useDashboardStore((s) => s.dashboardConfig);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  // 에이전트 목록 (dashboardConfig에서)
  const agents: DashboardAgentConfig[] = dashboardConfig?.agents ?? [];

  // '클로드 코드 세션' 폴더 ID
  const claudeFolder = catalog?.folders.find((f) => f.name === '클로드 코드 세션');

  // 폴더 초기화 1회 제한 — catalog 갱신 시 사용자 선택을 덮어쓰지 않도록
  const folderInitialized = useRef(false);

  // 모달이 열릴 때 진입 경로에 따라 초기 폴더 설정
  // catalog가 로드되기 전에는 설정하지 않는다 (Base UI Select가 UUID를 fallback 표시하는 것 방지)
  useEffect(() => {
    if (!isOpen) {
      folderInitialized.current = false;
      return;
    }
    if (folderInitialized.current || !catalog) return;

    folderInitialized.current = true;
    if (newSessionSource === 'feed') {
      setSelectedModalFolderId(claudeFolder?.id ?? null);
    } else {
      setSelectedModalFolderId(selectedFolderId);
    }
    // 에이전트가 하나뿐이면 자동 선택
    if (agents.length === 1) {
      setSelectedAgentId(agents[0].id);
    }
  }, [isOpen, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

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
          ...(selectedAgentId ? { profile: selectedAgentId } : {}),
        }),
      });

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          errorMessage = body.error?.message ?? errorMessage;
        } catch {
          // 서버가 JSON이 아닌 응답을 반환한 경우 (nginx 오류 페이지 등)
          errorMessage = `Server error (${response.status})`;
        }
        throw new Error(errorMessage);
      }

      let result: CreateSessionResponse;
      try {
        result = await response.json();
      } catch {
        throw new Error("Server returned an invalid response");
      }

      // 성공: draft 삭제, 낙관적 추가, 모달 닫기
      clearDraft(draftKey);
      const selectedAgent = agents.find((a) => a.id === selectedAgentId);
      addOptimisticSession(
        result.agentSessionId,
        prompt,
        selectedModalFolderId,
        result.nodeId,
        selectedAgentId || null,
        selectedAgent?.name ?? null,
        selectedAgent?.portraitUrl ?? null,
      );
      closeModal();
      setSelectedAgentId("");
    },
    [selectedModalFolderId, selectedAgentId, agents, addOptimisticSession, clearDraft, draftKey, closeModal],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal();
        setSelectedAgentId("");
      }
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
          <span className={cn("flex-1 truncate", !selectedModalFolderId && "text-muted-foreground/72")}>
            {selectedModalFolderId
              ? (catalog?.folders.find(f => f.id === selectedModalFolderId)?.name ?? "Select a folder...")
              : "Select a folder..."}
          </span>
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

  const agentSelector = agents.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Agent</label>
      <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
        <SelectTrigger>
          {(() => {
            const agent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : null;
            if (agent) {
              return (
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {agent.portraitUrl && (
                    <img src={agent.portraitUrl} alt={agent.name} className="w-5 h-5 rounded shrink-0 object-cover" />
                  )}
                  <span className="flex-1 truncate">{agent.name}</span>
                </div>
              );
            }
            return <span className="flex-1 truncate text-muted-foreground/72">Select an agent...</span>;
          })()}
        </SelectTrigger>
        <SelectPopup>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <div className="flex items-center gap-2">
                {a.portraitUrl && (
                  <img src={a.portraitUrl} alt={a.name} className="w-5 h-5 rounded shrink-0 object-cover" />
                )}
                {a.name}
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  ) : undefined;

  return (
    <NewSessionDialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      onSubmit={handleSubmit}
      folderSelector={folderSelector}
      agentSelector={agentSelector}
      subtitle={`in ${selectedModalFolderName}`}
      initialDraft={initialDraft}
      onDraftChange={handleDraftChange}
    />
  );
}
