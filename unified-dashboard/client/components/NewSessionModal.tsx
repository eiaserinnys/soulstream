/**
 * NewSessionModal - 새 세션 생성 모달 (unified-dashboard)
 *
 * soul-dashboard의 NewSessionModal에서 포팅.
 * 폴더별 draft 관리와 세션 생성 API 호출을 담당하는 얇은 래퍼.
 * UI 본체는 soul-ui의 NewSessionDialog에 위임한다.
 *
 * 진입 경로(newSessionSource)에 따라 초기 폴더를 다르게 설정한다:
 * - 'feed' 진입: 기본 폴더 id(`claude`) 사전 선택
 * - 'folder' 진입: 현재 선택된 폴더 사전 선택
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDashboardStore,
  NewSessionDialog,
  NewSessionFolderSelector,
  Select,
  SelectTrigger,
  SelectPopup,
  SelectItem,
  reasoningEffortLabel,
  DEFAULT_FOLDER_ID,
  placeBoardSessionInYjs,
  type DashboardAgentConfig,
} from "@seosoyoung/soul-ui";
import {
  defaultEffortForPreset,
  effortOptionsForPreset,
  isEffortSupported,
  reasoningEffortForSubmit,
} from "../utils/reasoningEffort";
import { useAppConfig } from "../config/AppConfigContext";
import { useNodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { createDashboardSession } from "client/lib/session-create";

export function NewSessionModal() {
  const queryClient = useQueryClient();
  const isOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeModal = useDashboardStore((s) => s.closeNewSessionModal);
  const addOptimisticSession = useDashboardStore((s) => s.addOptimisticSession);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const newSessionDefaults = useDashboardStore((s) => s.newSessionDefaults);
  const catalog = useDashboardStore((s) => s.catalog);
  const dashboardConfig = useDashboardStore((s) => s.dashboardConfig);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);

  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  // null = follow the agent's preset default.
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<string | null>(null);

  // 에이전트 목록 (dashboardConfig에서)
  const agents: DashboardAgentConfig[] = dashboardConfig?.agents ?? [];

  const defaultFolderExists = catalog?.folders.some((f) => f.id === DEFAULT_FOLDER_ID) ?? false;

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
    const defaultFolderId =
      newSessionDefaults?.folderId &&
      catalog.folders.some((folder) => folder.id === newSessionDefaults.folderId)
        ? newSessionDefaults.folderId
        : null;
    const defaultAgentId =
      newSessionDefaults?.agentId &&
      agents.some((agent) => agent.id === newSessionDefaults.agentId)
        ? newSessionDefaults.agentId
        : null;

    if (defaultFolderId) {
      setSelectedModalFolderId(defaultFolderId);
    } else if (newSessionSource === 'feed') {
      setSelectedModalFolderId(defaultFolderExists ? DEFAULT_FOLDER_ID : null);
    } else {
      setSelectedModalFolderId(selectedFolderId);
    }
    if (defaultAgentId) {
      setSelectedAgentId(defaultAgentId);
    } else if (agents.length === 1) {
      setSelectedAgentId(agents[0].id);
    }
  }, [isOpen, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftKey = `__draft__${selectedModalFolderId ?? "null"}`;

  // 선택된 폴더명 계산
  const selectedModalFolderName =
    catalog?.folders.find((f) => f.id === selectedModalFolderId)?.name ??
    "Claude Code";
  // This surface picks an agent, not a preset, so the effort default is looked
  // up through the agent's default preset in the local node's model catalog.
  const { nodeId: localNodeId } = useAppConfig();
  const presetCatalog = useNodeModelPresetCatalog(localNodeId ?? "");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const agentPresetId = selectedAgent?.defaultPreset ?? null;
  const selectedModelPresetInfo = agentPresetId
    ? presetCatalog.presets.find((preset) => preset.id === agentPresetId) ?? null
    : null;
  const effortOptions = effortOptionsForPreset(selectedModelPresetInfo);
  const presetDefaultEffort = defaultEffortForPreset(selectedModelPresetInfo);
  const effectiveReasoningEffort = selectedReasoningEffort ?? presetDefaultEffort;
  const submitReasoningEffort = reasoningEffortForSubmit(
    selectedModelPresetInfo,
    selectedReasoningEffort,
  );

  // Changing agent refills that agent's preset default; an unsupported manual
  // carry-over is dropped instead of being silently downgraded.
  useEffect(() => {
    if (!isEffortSupported(selectedModelPresetInfo, selectedReasoningEffort)) {
      setSelectedReasoningEffort(null);
    }
  }, [selectedModelPresetInfo, selectedReasoningEffort]);

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
    async (prompt: string, attachmentPaths?: string[]) => {
      const selectedAgent = agents.find((a) => a.id === selectedAgentId);
      const boardPosition = newSessionDefaults?.boardPosition ?? null;
      const result = await createDashboardSession({
        queryClient,
        addOptimisticSession,
        prompt,
        attachmentPaths,
        folderId: selectedModalFolderId ?? undefined,
        container: newSessionDefaults?.container ?? null,
        sourceTaskItemId: newSessionDefaults?.sourceTaskItemId ?? null,
        agentId: selectedAgentId || null,
        agent: selectedAgent ?? null,
        reasoningEffort: submitReasoningEffort,
        boardPosition,
      });

      // 성공: draft 삭제, 보드 배치 반영, 모달 닫기
      clearDraft(draftKey);
      if (boardPosition && selectedModalFolderId && newSessionDefaults?.container?.kind !== "task") {
        placeBoardSessionInYjs(
          selectedModalFolderId,
          result.agentSessionId,
          boardPosition,
        );
      }
      closeModal();
      setSelectedAgentId("");
      setSelectedReasoningEffort(null);
    },
    [queryClient, selectedModalFolderId, selectedAgentId, submitReasoningEffort, agents, addOptimisticSession, clearDraft, draftKey, closeModal, newSessionDefaults?.boardPosition, newSessionDefaults?.container, newSessionDefaults?.sourceTaskItemId],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal();
        setSelectedAgentId("");
        setSelectedReasoningEffort(null);
      }
    },
    [closeModal],
  );

  const folderSelector = (
    <NewSessionFolderSelector
      folders={catalog?.folders ?? []}
      selectedFolderId={selectedModalFolderId}
      onFolderChange={setSelectedModalFolderId}
    />
  );

  const agentSelector = agents.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Agent</label>
      <Select value={selectedAgentId} onValueChange={(v) => setSelectedAgentId(v ?? "")}>
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

  const optionsSlot = effortOptions.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Reasoning Effort</label>
      <Select
        value={effectiveReasoningEffort ?? ""}
        onValueChange={(v) => setSelectedReasoningEffort(v || null)}
      >
        <SelectTrigger>
          <span className="flex-1 truncate">
            {effectiveReasoningEffort
              ? reasoningEffortLabel(effectiveReasoningEffort)
              : "자동 (백엔드 기본값)"}
          </span>
        </SelectTrigger>
        <SelectPopup>
          {effortOptions.map((option) => (
            <SelectItem key={option} value={option}>
              {reasoningEffortLabel(option)}
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
      optionsSlot={optionsSlot}
      initialDraft={initialDraft}
      onDraftChange={handleDraftChange}
      fileUploadUrl="/attachments/sessions"
      title="New Session"
      subtitle={`in ${selectedModalFolderName}`}
    />
  );
}
