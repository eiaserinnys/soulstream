/**
 * OrchestratorNewSessionModal - orchestrator 모드 새 세션 생성 모달 (unified-dashboard)
 *
 * orchestrator-dashboard의 NewSessionDialog.tsx에서 포팅.
 * soul-ui의 NewSessionDialog 위에 노드 선택 UI를 추가한다.
 * Phase 4의 NewSessionModal(single-node 용)과 달리 노드 선택이 포함된다.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  NewSessionDialog as BaseNewSessionDialog,
  Select,
  SelectTrigger,
  SelectPopup,
  SelectItem,
  useDashboardStore,
  cn,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_OPTIONS,
  toastManager,
  type ReasoningEffort,
} from "@seosoyoung/soul-ui";
import type { AgentInfo } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { useAppConfig } from "../config/AppConfigContext";
import {
  reasoningEffortForSubmit,
  selectedAgentBackend,
} from "../utils/reasoningEffort";
import { updateBoardItemPosition } from "../lib/board-workspace-operations";

interface OAuthProfile {
  name: string;
}

export function OrchestratorNewSessionModal() {
  // useCallback 내부에서 항상 최신 queryClient를 참조하기 위해 ref 패턴 사용
  const queryClientRef = useRef<QueryClient | null>(null);
  const queryClient = useQueryClient();
  queryClientRef.current = queryClient;
  const { nodeId: localNodeId } = useAppConfig();

  const isModalOpen = useDashboardStore((s) => s.isNewSessionModalOpen);
  const closeNewSessionModal = useDashboardStore((s) => s.closeNewSessionModal);
  const newSessionSource = useDashboardStore((s) => s.newSessionSource);
  const newSessionParentTask = useDashboardStore((s) => s.newSessionParentTask);
  const newSessionDefaults = useDashboardStore((s) => s.newSessionDefaults);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const setDraft = useDashboardStore((s) => s.setDraft);
  const clearDraft = useDashboardStore((s) => s.clearDraft);
  const nodes = useOrchestratorStore((s) => s.nodes);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedModalFolderId, setSelectedModalFolderId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>(
    DEFAULT_REASONING_EFFORT,
  );
  const [oauthProfiles, setOauthProfiles] = useState<OAuthProfile[]>([]);
  const [selectedOAuthProfile, setSelectedOAuthProfile] = useState<string | null>(null);

  const aliveNodes = useMemo(
    () => Array.from(nodes.values()).filter((n) => n.status === "connected"),
    [nodes],
  );

  // '클로드 코드 세션' 폴더 ID
  const claudeFolder = catalog?.folders.find((f) => f.name === '클로드 코드 세션');
  const taskIdempotencyKeyRef = useRef<string | null>(null);
  const draftKey = newSessionParentTask
    ? `__draft__orchestrator__task__${newSessionParentTask.id}`
    : `__draft__orchestrator__${selectedNodeId || "null"}__${selectedModalFolderId ?? "null"}`;
  const initialDraft = useMemo(() => {
    return useDashboardStore.getState().drafts[draftKey] ?? "";
  }, [draftKey, isModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedBackend = selectedAgentBackend(agents, selectedAgentId);
  const submitReasoningEffort = reasoningEffortForSubmit(
    selectedBackend,
    selectedReasoningEffort,
  );

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(draftKey, value);
    },
    [draftKey, setDraft],
  );

  // 폴더 초기화 1회 제한 — catalog 갱신 시 사용자 선택을 덮어쓰지 않도록
  const folderInitialized = useRef(false);

  // 모달이 열릴 때 진입 경로에 따라 초기 폴더 설정
  useEffect(() => {
    if (!isModalOpen) {
      folderInitialized.current = false;
      taskIdempotencyKeyRef.current = null;
      return;
    }
    if (folderInitialized.current || !catalog) return;

    folderInitialized.current = true;
    const defaultFolderId =
      newSessionDefaults?.folderId &&
      catalog.folders.some((folder) => folder.id === newSessionDefaults.folderId)
        ? newSessionDefaults.folderId
        : null;

    if (defaultFolderId) {
      setSelectedModalFolderId(defaultFolderId);
    } else if (newSessionSource === 'feed') {
      setSelectedModalFolderId(claudeFolder?.id ?? null);
    } else {
      setSelectedModalFolderId(selectedFolderId);
    }
  }, [isModalOpen, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isModalOpen || !newSessionParentTask) {
      taskIdempotencyKeyRef.current = null;
      return;
    }
    taskIdempotencyKeyRef.current = createTaskIdempotencyKey(newSessionParentTask.id);
  }, [isModalOpen, newSessionParentTask?.id]);

  // 앱/WebView에서는 현재 노드가 명확한 경우가 많다. 노드가 자동 선택되면
  // NewSessionDialog가 즉시 fileUploadUrl을 받아 세션 생성 전 첨부 UI를 표시한다.
  useEffect(() => {
    if (!isModalOpen || selectedNodeId) return;
    if (newSessionDefaults?.nodeId) {
      setSelectedNodeId(newSessionDefaults.nodeId);
      return;
    }
    if (localNodeId && aliveNodes.some((n) => n.nodeId === localNodeId)) {
      setSelectedNodeId(localNodeId);
      return;
    }
    if (aliveNodes.length === 1) {
      setSelectedNodeId(aliveNodes[0].nodeId);
    }
  }, [isModalOpen, selectedNodeId, newSessionDefaults?.nodeId, localNodeId, aliveNodes]);

  // nodeId 변경 시 에이전트 목록 및 OAuth 프로필 조회
  useEffect(() => {
    setSelectedAgentId("");
    setAgents([]);
    setSelectedOAuthProfile(null);
    setOauthProfiles([]);
    if (!selectedNodeId) return;

    const defaultAgentId =
      newSessionDefaults?.agentId &&
      (!newSessionDefaults.nodeId || newSessionDefaults.nodeId === selectedNodeId)
        ? newSessionDefaults.agentId
        : null;

    fetch(`/api/nodes/${encodeURIComponent(selectedNodeId)}/agents`)
      .then((res) => res.json())
      .then((data: { agents: AgentInfo[] }) => {
        const nextAgents = data.agents ?? [];
        setAgents(nextAgents);
        if (defaultAgentId && nextAgents.some((agent) => agent.id === defaultAgentId)) {
          setSelectedAgentId(defaultAgentId);
        }
      })
      .catch(() => {
        // 에이전트 목록 조회 실패 시 graceful degradation
        setAgents([]);
      });

    fetch(`/api/nodes/${encodeURIComponent(selectedNodeId)}/oauth-profiles`)
      .then((res) => res.json())
      .then((data: { profiles: OAuthProfile[] }) => {
        setOauthProfiles(data.profiles ?? []);
      })
      .catch(() => {
        // OAuth 프로필 조회 실패 시 graceful degradation
        setOauthProfiles([]);
      });
  }, [selectedNodeId, newSessionDefaults?.agentId, newSessionDefaults?.nodeId]);

  const handleSubmit = useCallback(
    async (prompt: string, attachmentPaths?: string[]) => {
      if (!selectedNodeId) throw new Error("Please select a node");

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          nodeId: selectedNodeId,
          ...(attachmentPaths?.length ? { attachmentPaths } : {}),
          ...(selectedModalFolderId ? { folderId: selectedModalFolderId } : {}),
          ...(selectedAgentId ? { profile: selectedAgentId } : {}),
          ...(submitReasoningEffort ? { reasoningEffort: submitReasoningEffort } : {}),
          ...(selectedOAuthProfile ? { oauth_profile_name: selectedOAuthProfile } : {}),
          ...(newSessionParentTask
            ? {
                parentTaskId: newSessionParentTask.id,
                taskIdempotencyKey:
                  taskIdempotencyKeyRef.current ?? createTaskIdempotencyKey(newSessionParentTask.id),
              }
            : {}),
        }),
      });

      if (!res.ok) {
        let errorMessage = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          // FastAPI HTTPException → body.detail, custom error → body.error
          errorMessage = body.detail ?? body.error ?? errorMessage;
        } catch {
          errorMessage = `Server error (${res.status})`;
        }
        throw new Error(errorMessage);
      }

      let sessionData: { agentSessionId: string };
      try {
        sessionData = await res.json();
      } catch {
        throw new Error("Server returned an invalid response");
      }

      const { agentSessionId } = sessionData;
      const { addOptimisticSession } = useDashboardStore.getState();
      const selectedAgent = agents.find((a) => a.id === selectedAgentId);
      const boardPosition = newSessionDefaults?.boardPosition ?? null;
      addOptimisticSession(
        queryClientRef.current!,
        agentSessionId,
        prompt,
        selectedModalFolderId ?? null,
        selectedNodeId,
        selectedAgentId || null,
        selectedAgent?.name ?? null,
        selectedAgent?.portraitUrl ?? null,
        selectedAgent?.backend ?? null,
        boardPosition,
      );
      if (boardPosition && selectedModalFolderId) {
        try {
          await updateBoardItemPosition(`session:${agentSessionId}`, boardPosition.x, boardPosition.y);
        } catch (err) {
          toastManager.add({
            title: "Session placement failed",
            description: "The session was created, but the board position was restored by the server.",
            type: "warning",
          });
          console.error("Session board item placement failed:", err);
        }
      }
      clearDraft(draftKey);
      closeNewSessionModal();
      setSelectedNodeId("");
      setSelectedModalFolderId(null);
      setSelectedAgentId("");
      setSelectedReasoningEffort(DEFAULT_REASONING_EFFORT);
      setSelectedOAuthProfile(null);
    },
    [selectedNodeId, selectedModalFolderId, selectedAgentId, submitReasoningEffort, selectedOAuthProfile, newSessionParentTask, agents, clearDraft, draftKey, closeNewSessionModal, newSessionDefaults?.boardPosition],
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

  const nodeSelector = (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Node</label>
      <Select value={selectedNodeId} onValueChange={(v) => setSelectedNodeId(v ?? "")}>
        <SelectTrigger>
          <span className={cn("flex-1 truncate", !selectedNodeId && "text-muted-foreground/72")}>
            {selectedNodeId
              ? (() => {
                  const node = aliveNodes.find(n => n.nodeId === selectedNodeId);
                  return node ? `${node.nodeId} (${node.host}:${node.port})` : selectedNodeId;
                })()
              : "Select a node..."}
          </span>
        </SelectTrigger>
        <SelectPopup>
          {aliveNodes.map((n) => (
            <SelectItem key={n.nodeId} value={n.nodeId}>
              {n.nodeId}
              <span className="ml-2 text-xs font-mono text-muted-foreground/50">
                {n.host}:{n.port}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );

  const oauthProfileSelector = oauthProfiles.length > 0 ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">OAuth Profile</label>
      <Select value={selectedOAuthProfile ?? ''} onValueChange={(v) => setSelectedOAuthProfile(v || null)}>
        <SelectTrigger>
          <span className={cn("flex-1 truncate", !selectedOAuthProfile && "text-muted-foreground/72")}>
            {selectedOAuthProfile ?? "없음 (기본 토큰 사용)"}
          </span>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="">없음 (기본 토큰 사용)</SelectItem>
          {oauthProfiles.map((p) => (
            <SelectItem key={p.name} value={p.name}>
              {p.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  ) : undefined;

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

  const optionsSlot = submitReasoningEffort ? (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">Reasoning Effort</label>
      <Select
        value={selectedReasoningEffort}
        onValueChange={(v) => setSelectedReasoningEffort((v || DEFAULT_REASONING_EFFORT) as ReasoningEffort)}
      >
        <SelectTrigger>
          <span className="flex-1 truncate">
            {REASONING_EFFORT_OPTIONS.find((option) => option.value === selectedReasoningEffort)?.label}
          </span>
        </SelectTrigger>
        <SelectPopup>
          {REASONING_EFFORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  ) : undefined;

  return (
    <BaseNewSessionDialog
      open={isModalOpen}
      onOpenChange={(v) => {
        if (!v) {
          closeNewSessionModal();
          setSelectedNodeId("");
          setSelectedModalFolderId(null);
          setSelectedAgentId("");
          setSelectedReasoningEffort(DEFAULT_REASONING_EFFORT);
          setSelectedOAuthProfile(null);
        }
      }}
      onSubmit={handleSubmit}
      folderSelector={folderSelector}
      nodeSelector={nodeSelector}
      agentSelector={agentSelector}
      oauthProfileSelector={oauthProfileSelector}
      optionsSlot={optionsSlot}
      submitDisabled={!selectedNodeId}
      title={newSessionParentTask ? "하위 대화 시작" : "New Session"}
      subtitle={newSessionParentTask ? `under ${newSessionParentTask.title}` : undefined}
      initialDraft={initialDraft}
      onDraftChange={handleDraftChange}
      fileUploadUrl={
        selectedNodeId
          ? `/api/attachments/sessions?nodeId=${encodeURIComponent(selectedNodeId)}`
          : undefined
      }
    />
  );
}

function createTaskIdempotencyKey(taskId: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `task-session:${taskId}:${random}`;
}
