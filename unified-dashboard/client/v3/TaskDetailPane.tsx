import { useEffect, useMemo, useRef, useState } from "react";
import { useGlassSurface, type SessionSummary } from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import { plannerStatusPresentation } from "./planner-model";
import type { PageSessionDefaults } from "./task-workspace-api";
import { descriptionMarkdown } from "./task-workspace-model";
import { TaskDescriptionPanel } from "./TaskDescriptionPanel";
import { TaskContextPicker } from "./TaskContextPicker";
import { TaskRunHistory } from "./TaskRunHistory";
import "./v3-context-succession.css";

export function TaskDetailPane({
  task,
  sessions,
  sessionDefaults,
  onReturnToPlanner,
  onOpenBoard,
  onOpenSession,
  onSaveDescription,
  onPromoteDocument,
}: {
  task: PlannerTask;
  sessions: readonly SessionSummary[];
  sessionDefaults: PageSessionDefaults | null;
  onReturnToPlanner(): void;
  onOpenBoard(): void;
  onOpenSession(session: SessionSummary): void;
  onSaveDescription(markdown: string): Promise<void>;
  onPromoteDocument(blockId: string): Promise<void>;
}) {
  const surfaceRef = useRef<HTMLElement>(null);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const description = useMemo(
    () => descriptionMarkdown(task.page, task.blocks),
    [task.blocks, task.page],
  );
  const status = plannerStatusPresentation(task.status);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [contextBlocks, setContextBlocks] = useState(task.blocks);
  const [predecessorSessionId, setPredecessorSessionId] = useState<string | null>(null);
  const [createdSessions, setCreatedSessions] = useState<SessionSummary[]>([]);
  useEffect(() => {
    setContextBlocks(task.blocks);
    setContextPickerOpen(false);
    setPredecessorSessionId(null);
    setCreatedSessions([]);
  }, [task.blocks, task.page.id]);
  const contexts = contextBlocks.flatMap((block) => {
    if (block.block_type === "atom_ref") {
      const label = stringProperty(block.properties, "title")
        ?? stringProperty(block.properties, "label")
        ?? stringProperty(block.properties, "nodeId")
        ?? "atom 컨텍스트";
      return [{ id: block.id, icon: "⚛", label }];
    }
    if (block.block_type === "guidance") {
      return [{ id: block.id, icon: "✦", label: block.text.trim() || "실행 지침" }];
    }
    return [];
  });
  const mountedContextTitles = contextBlocks.flatMap((block) => {
    const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
    return match ? [{ id: block.id, title: match[1] }] : [];
  });
  const allSessions = [...sessions, ...createdSessions.filter((created) => !sessions.some((session) => session.agentSessionId === created.agentSessionId))];
  const allSessionIds = [...task.sessionIds, ...createdSessions.map((session) => session.agentSessionId)];

  const promote = async (blockId: string) => {
    setPromotingId(blockId);
    try {
      await onPromoteDocument(blockId);
    } finally {
      setPromotingId(null);
    }
  };

  return (
    <article
      ref={surfaceRef}
      className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
    >
      <header className="v3-workspace-toolbar">
        <button type="button" className="v3-workspace-back" onClick={onReturnToPlanner}>← 오늘로</button>
        <span className="v3-spacer" />
        <button type="button" className="v3-workspace-close" aria-label="업무 상세 닫기" onClick={onReturnToPlanner}>×</button>
      </header>
      <div className="v3-detail-scroll">
        <div className="v3-detail-title">
          <span className={`v3-status-chip v3-status-chip--${task.status}`}>{status.icon} {status.label}</span>
          <h2>{task.page.title}</h2>
          <button
            type="button"
            className="v3-button v3-button--soft"
            title="이행 기간에는 기존 v1 보드 폴더에서 엽니다"
            onClick={onOpenBoard}
          >
            ▦ 보드로 보기
          </button>
        </div>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head"><h3>설명</h3><span>마크다운</span></div>
          <TaskDescriptionPanel markdown={description} onSave={onSaveDescription} />
        </section>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head"><h3>컨텍스트</h3><span>{contexts.length + mountedContextTitles.length}개</span></div>
          <div className="v3-context-chips">
            {contexts.map((context) => <span key={context.id}>{context.icon} {context.label}</span>)}
            {mountedContextTitles.map((document) => <span key={document.id}><span className="v3-emoji" aria-hidden="true">📄</span> {document.title}</span>)}
            {contexts.length + mountedContextTitles.length === 0 ? <small>연결된 컨텍스트가 없습니다.</small> : null}
            <button type="button" className="v3-context-add" aria-expanded={contextPickerOpen} onClick={() => setContextPickerOpen((value) => !value)}>＋ 컨텍스트</button>
          </div>
          {contextPickerOpen ? (
            <TaskContextPicker
              taskPageId={task.page.id}
              taskBlocks={contextBlocks}
              projectPageId={task.projectPageId}
              sessionIds={allSessionIds}
              sessions={allSessions}
              sessionDefaults={sessionDefaults}
              predecessorSessionId={predecessorSessionId}
              onBlocksChanged={setContextBlocks}
              onPredecessorChanged={setPredecessorSessionId}
              onClose={() => setContextPickerOpen(false)}
            />
          ) : null}
        </section>

        <section className="v3-detail-section">
          <div className="v3-detail-section-head"><h3><span className="v3-emoji" aria-hidden="true">📄</span> 문서</h3><span>{task.mountedDocuments.length}개</span></div>
          <div className="v3-task-documents">
            {task.mountedDocuments.map((document) => (
              <div key={document.blockId}>
                <span>{document.page.title}</span>
                <button
                  type="button"
                  className="v3-button v3-button--ghost"
                  disabled={!task.projectPageId || promotingId === document.blockId}
                  title={task.projectPageId ? "업무의 문서 마운트를 프로젝트 페이지로 이동합니다" : "프로젝트에 속한 업무만 승격할 수 있습니다"}
                  onClick={() => { void promote(document.blockId); }}
                >
                  {promotingId === document.blockId ? "승격 중…" : "프로젝트로 승격"}
                </button>
              </div>
            ))}
            {task.mountedDocuments.length === 0 ? <p className="v3-detail-empty">마운트된 문서가 없습니다.</p> : null}
          </div>
        </section>

        {sessionDefaults?.agentId || sessionDefaults?.nodeId ? (
          <div className="v3-session-defaults"><span className="v3-emoji" aria-hidden="true">👤</span> 기본값: {sessionDefaults.agentId ?? "agent 미지정"}@{sessionDefaults.nodeId ?? "node 미지정"} <span>(상속)</span></div>
        ) : null}

        <TaskRunHistory
          taskTitle={task.page.title}
          taskPageId={task.page.id}
          runbookId={task.runbookId}
          contextCount={contexts.length + mountedContextTitles.length}
          sessionDefaults={sessionDefaults}
          predecessorSessionId={predecessorSessionId}
          sessionIds={allSessionIds}
          sessions={allSessions}
          onOpenSession={onOpenSession}
          onSessionCreated={(session) => {
            setCreatedSessions((current) => [...current, session]);
            setPredecessorSessionId(null);
            onOpenSession(session);
          }}
        />
      </div>
    </article>
  );
}

function stringProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
