import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDashboardStore,
  useGlassSurface,
  type AgentInfo,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";

import { createDashboardSession } from "../lib/session-create";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
import {
  buildSuccessionCreateOptions,
  resolveRunAssignmentDefaults,
} from "./session-succession-model";
import {
  createTaskPageAnchor,
  type PageSessionDefaults,
} from "./task-workspace-api";

const SUCCESSOR_PROMPT = "새 업무 run을 시작하고 사용자의 다음 지시를 기다려주세요.";

export function SessionSuccessionModal({
  taskTitle,
  taskPageId,
  runbookId,
  contextCount,
  pageDefaults,
  currentSession,
  predecessorSessionId,
  onClose,
  onCreated,
}: {
  taskTitle: string;
  taskPageId: string;
  runbookId: string;
  contextCount: number;
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
  const predecessorId = predecessorSessionId ?? currentSession?.agentSessionId ?? null;
  const [inheritCard, setInheritCard] = useState(true);
  const [inheritSummary, setInheritSummary] = useState(Boolean(predecessorId));
  const [selectedNodeId, setSelectedNodeId] = useState(resolvedDefaults.nodeId ?? "");
  const [selectedAgentId, setSelectedAgentId] = useState(resolvedDefaults.agentId ?? "");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [preparedPageAnchor, setPreparedPageAnchor] = useState<Awaited<ReturnType<typeof createTaskPageAnchor>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const modalWebglActive = useGlassSurface(modalRef, { enabled: true });

  const selectedCount = (inheritCard ? 2 : 0) + (inheritSummary && predecessorId ? 1 : 0);
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
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="v3-succession-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <section
        ref={modalRef}
        className="v3-succession-modal border border-glass-border glass-strong glass-chrome lg-rim"
        data-liquid-glass-webgl={modalWebglActive ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="v3-succession-title"
      >
        <header>
          <span>↗</span>
          <div><h2 id="v3-succession-title">새 세션 · 승계 미리보기</h2><p>체크를 모두 끄면 빈 세션으로 시작합니다.</p></div>
          <button type="button" aria-label="승계 닫기" disabled={pending} onClick={onClose}>×</button>
        </header>
        <div className="v3-succession-body">
          <p><strong>{taskTitle}</strong>의 새 run이 이어받을 것</p>
          <ol>
            <li><label><input type="checkbox" checked={inheritCard} onChange={(event) => setInheritCard(event.target.checked)} /><span><strong>업무 카드 본문</strong><small>목표·완료 조건·현재 결정</small></span></label></li>
            <li><label><input type="checkbox" checked={inheritSummary} disabled={!predecessorId} onChange={(event) => setInheritSummary(event.target.checked)} /><span><strong>직전 run 요약</strong><small>{predecessorId ? `${predecessorId.slice(0, 12)}… 요약` : "직전 run 없음"}</small>{predecessorId ? <em>승계 링크로 기록됨</em> : null}</span></label></li>
            <li><label><input type="checkbox" checked={inheritCard} disabled /><span><strong>컨텍스트 슬롯</strong><small>{contextCount}건 · 업무 카드 본문에 포함</small></span></label></li>
          </ol>
          <div className="v3-succession-choice">{selectedCount}개 선택 · {selectedCount ? "승계 세션" : "빈 세션"}</div>
          <AgentNodeAssignmentFields agentId={selectedAgentId} nodeId={selectedNodeId} preferredAgentId={resolvedDefaults.agentId} preferredNodeId={resolvedDefaults.nodeId} fallbackToAvailable onAgentIdChange={setSelectedAgentId} onNodeIdChange={setSelectedNodeId} onAgentInfoChange={setSelectedAgent} onError={setError} />
          <small className="v3-succession-default-source">기본값: {resolvedDefaults.source === "page-defaults" ? "프로젝트 상속" : resolvedDefaults.source === "current-session" ? "현재 run" : "직접 선택"}</small>
        </div>
        {error ? <div className="v3-succession-error" role="alert">세션 시작 실패 · {error}</div> : null}
        <footer><button type="button" className="v3-button v3-button--ghost" disabled={pending} onClick={onClose}>취소</button><button type="button" className="v3-button v3-button--primary" disabled={pending || !selectedNodeId || !selectedAgentId || selectedAgent?.id !== selectedAgentId} onClick={() => { void start(); }}>{pending ? "시작 중…" : "시작"}</button></footer>
      </section>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
