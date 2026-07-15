import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  useDashboardStore,
  type AgentInfo,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { createDashboardSession } from "../lib/session-create";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
import {
  buildSuccessionCreateOptions,
  resolveRunAssignmentDefaults,
  type SuccessionSessionOption,
} from "./session-succession-model";
import {
  createTaskPageAnchor,
  type PageSessionDefaults,
} from "./task-workspace-api";
import { V3ErrorNotice } from "./V3ErrorNotice";

const SUCCESSOR_PROMPT = "새 업무 run을 시작하고 사용자의 다음 지시를 기다려주세요.";

export interface SuccessionContextItem {
  id: string;
  icon: string;
  label: string;
}

export function SessionSuccessionModal({
  taskTitle,
  taskPageId,
  runbookId,
  contextItems,
  predecessorOptions,
  pageDefaults,
  currentSession,
  predecessorSessionId,
  onClose,
  onCreated,
}: {
  taskTitle: string;
  taskPageId: string;
  runbookId: string;
  contextItems: readonly SuccessionContextItem[];
  predecessorOptions: readonly SuccessionSessionOption[];
  pageDefaults: PageSessionDefaults | null;
  currentSession: SessionSummary | null;
  predecessorSessionId: string | null;
  onClose(): void;
  onCreated(session: SessionSummary): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const queryClient = useQueryClient();
  const resolvedDefaults = useMemo(() => resolveRunAssignmentDefaults({
    pageDefaults,
    currentSession,
  }), [currentSession, pageDefaults]);
  const defaultPredecessorId = predecessorSessionId
    ?? currentSession?.agentSessionId
    ?? predecessorOptions[0]?.sessionId
    ?? null;
  const [selectedPredecessorId, setSelectedPredecessorId] = useState(defaultPredecessorId);
  const selectedPredecessor = predecessorOptions.find(
    (option) => option.sessionId === selectedPredecessorId,
  ) ?? predecessorOptions[0] ?? null;
  const selectedPredecessorIndex = selectedPredecessor
    ? predecessorOptions.indexOf(selectedPredecessor)
    : -1;
  const predecessorId = selectedPredecessor?.sessionId ?? null;
  const [inheritCard, setInheritCard] = useState(true);
  const [inheritSummary, setInheritSummary] = useState(Boolean(predecessorId));
  const [selectedNodeId, setSelectedNodeId] = useState(resolvedDefaults.nodeId ?? "");
  const [selectedAgentId, setSelectedAgentId] = useState(resolvedDefaults.agentId ?? "");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [preparedPageAnchor, setPreparedPageAnchor] = useState<Awaited<ReturnType<typeof createTaskPageAnchor>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleAssignmentError = useCallback((message: string) => {
    console.error("[v3/session-succession] 실행 대상 조회 실패", message);
    setError(message);
  }, []);

  const start = async () => {
    if (!selectedNodeId || !selectedAgentId) return;
    setPending(true);
    setError(null);
    try {
      const pageAnchor = inheritCard
        ? preparedPageAnchor ?? await createTaskPageAnchor(api, taskPageId)
        : null;
      if (pageAnchor && !preparedPageAnchor) setPreparedPageAnchor(pageAnchor);
      const succession = buildSuccessionCreateOptions({
        inheritCard,
        inheritSummary,
        pageAnchor,
        predecessorSessionId: predecessorId,
      });
      const result = await createDashboardSession({
        queryClient,
        addOptimisticSession: useDashboardStore.getState().addOptimisticSession,
        prompt: SUCCESSOR_PROMPT,
        nodeId: selectedNodeId,
        agentId: selectedAgentId,
        agent: selectedAgent,
        container: { kind: "runbook", id: runbookId },
        ...succession,
      });
      const now = new Date().toISOString();
      onCreated({
        agentSessionId: result.agentSessionId,
        status: "running",
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
        displayName: `${taskTitle} run`,
        nodeId: result.nodeId ?? selectedNodeId,
        agentId: selectedAgentId,
        agentName: selectedAgent?.name ?? selectedAgentId,
        agentPortraitUrl: selectedAgent?.portraitUrl ?? undefined,
        backend: selectedAgent?.backend ?? undefined,
      });
      onClose();
    } catch (caught) {
      console.error("[v3/session-succession] 세션 시작 실패", caught);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup
        className="v3-succession-modal max-w-[520px]"
        closeProps={{ "aria-label": "승계 닫기", disabled: pending }}
      >
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">↗</span>
          <DialogTitle>새 세션</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          <p>새 세션의 컨텍스트</p>
          {error ? (
            <V3ErrorNotice
              className="v3-succession-error"
              message="새 세션을 시작하지 못했습니다."
              detail={error}
            />
          ) : null}
          <ol>
            <li>
              <label>
                <input
                  type="checkbox"
                  aria-label="업무 카드 본문과 컨텍스트 포함"
                  checked={inheritCard}
                  onChange={(event) => setInheritCard(event.target.checked)}
                />
                <span>
                  <strong>업무 카드 본문</strong>
                  <span className="v3-succession-context-chips">
                    {contextItems.map((context) => (
                      <span key={context.id}><span aria-hidden="true">{context.icon}</span> {context.label}</span>
                    ))}
                    {contextItems.length === 0 ? <small>연결된 컨텍스트 없음</small> : null}
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label>
                <input
                  type="checkbox"
                  aria-label="이전 세션 이어받기"
                  checked={inheritSummary}
                  disabled={!predecessorId}
                  onChange={(event) => setInheritSummary(event.target.checked)}
                />
                <span>
                  <strong>이전 세션</strong>
                  <select
                    aria-label="이어받을 이전 세션"
                    value={selectedPredecessorIndex < 0 ? "" : String(selectedPredecessorIndex)}
                    disabled={!inheritSummary || predecessorOptions.length === 0}
                    onChange={(event) => {
                      const option = predecessorOptions[Number(event.target.value)];
                      setSelectedPredecessorId(option?.sessionId ?? null);
                    }}
                  >
                    {predecessorOptions.length === 0 ? <option value="">이전 세션 없음</option> : null}
                    {predecessorOptions.map((option, index) => (
                      <option key={option.sessionId} value={String(index)}>
                        {option.label}{option.runNumber === null ? "" : ` · run #${option.runNumber}`}
                      </option>
                    ))}
                  </select>
                  {predecessorId ? (
                    <small>이전 세션을 이어 받을 경우 세션을 승계한 것으로 간주됩니다.</small>
                  ) : null}
                </span>
              </label>
            </li>
          </ol>
          <AgentNodeAssignmentFields agentId={selectedAgentId} nodeId={selectedNodeId} preferredAgentId={resolvedDefaults.agentId} preferredNodeId={resolvedDefaults.nodeId} fallbackToAvailable onAgentIdChange={setSelectedAgentId} onNodeIdChange={setSelectedNodeId} onAgentInfoChange={setSelectedAgent} onError={handleAssignmentError} />
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          <Button variant="ghost" disabled={pending} onClick={onClose}>취소</Button>
          <Button disabled={pending || !selectedNodeId || !selectedAgentId || selectedAgent?.id !== selectedAgentId} onClick={() => { void start(); }}>{pending ? "시작 중…" : "시작"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
