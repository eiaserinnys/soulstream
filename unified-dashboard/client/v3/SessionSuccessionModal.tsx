import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  FileAttachmentPreview,
  AtomNodeSelector,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  appendAttachmentPathNotes,
  useFileUpload,
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
import type { PageContextSourcesMarker } from "./project-context-inheritance";
import { buildSessionContextSelection } from "./session-context-items";

export interface SuccessionContextItem {
  id: string;
  icon: string;
  label: string;
}

export interface SuccessionDocumentOption {
  pageId: string;
  title: string;
}

export function SessionSuccessionModal({
  taskTitle,
  taskPageId,
  taskId,
  contextItems,
  documentOptions,
  pageContextSources,
  contextPending,
  predecessorOptions,
  pageDefaults,
  currentSession,
  onClose,
  onCreated,
}: {
  taskTitle: string;
  taskPageId: string;
  taskId: string;
  contextItems: readonly SuccessionContextItem[];
  documentOptions: readonly SuccessionDocumentOption[];
  pageContextSources: PageContextSourcesMarker;
  contextPending: boolean;
  predecessorOptions: readonly SuccessionSessionOption[];
  pageDefaults: PageSessionDefaults | null;
  currentSession: SessionSummary | null;
  onClose(): void;
  onCreated(session: SessionSummary): void;
}) {
  const api = useMemo(() => createPageApiClient(), []);
  const queryClient = useQueryClient();
  const resolvedDefaults = useMemo(() => resolveRunAssignmentDefaults({
    pageDefaults,
    currentSession,
  }), [currentSession, pageDefaults]);
  const defaultPredecessorId = currentSession?.agentSessionId
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
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set());
  const [pendingSessionId] = useState(() => crypto.randomUUID());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [atomNodeId, setAtomNodeId] = useState("");
  const [atomNodeTitle, setAtomNodeTitle] = useState("");
  const [initialInstruction, setInitialInstruction] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState(resolvedDefaults.nodeId ?? "");
  const [selectedAgentId, setSelectedAgentId] = useState(resolvedDefaults.agentId ?? "");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [preparedPageAnchor, setPreparedPageAnchor] = useState<Awaited<ReturnType<typeof createTaskPageAnchor>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadUrl = selectedNodeId
    ? `/api/attachments/sessions?nodeId=${encodeURIComponent(selectedNodeId)}`
    : "";
  const {
    files,
    isUploading,
    addFiles,
    removeFile,
    cancel,
    resetLocal,
    uploadedPaths,
  } = useFileUpload({ uploadUrl, sessionId: pendingSessionId });
  const contextSelection = useMemo(() => buildSessionContextSelection({
    inheritCard,
    pageContextSources,
    documentPageIds: documentOptions
      .filter((document) => selectedDocumentIds.has(document.pageId))
      .map((document) => document.pageId),
    atomNode: atomNodeId ? { nodeId: atomNodeId, title: atomNodeTitle } : null,
    guidance: "",
  }), [atomNodeId, atomNodeTitle, documentOptions, inheritCard, pageContextSources, selectedDocumentIds]);
  const handleAssignmentError = useCallback((message: string) => {
    console.error("[v3/session-succession] 실행 대상 조회 실패", message);
    setError(message);
  }, []);

  const start = async () => {
    if (!selectedNodeId || !selectedAgentId) return;
    setPending(true);
    setError(null);
    try {
      const pageAnchor = contextSelection.needsPageAnchor
        ? preparedPageAnchor ?? await createTaskPageAnchor(api, taskPageId)
        : null;
      if (pageAnchor && !preparedPageAnchor) setPreparedPageAnchor(pageAnchor);
      const succession = buildSuccessionCreateOptions({
        includePageContext: contextSelection.needsPageAnchor,
        inheritSummary,
        pageAnchor,
        predecessorSessionId: predecessorId,
      });
      const attachmentPaths = uploadedPaths.length > 0 ? uploadedPaths : undefined;
      const result = await createDashboardSession({
        queryClient,
        addOptimisticSession: useDashboardStore.getState().addOptimisticSession,
        initialInstruction: appendAttachmentPathNotes(initialInstruction, attachmentPaths),
        attachmentPaths,
        nodeId: selectedNodeId,
        agentId: selectedAgentId,
        agent: selectedAgent,
        container: { kind: "task", id: taskId },
        contextItems: contextSelection.contextItems.length > 0
          ? contextSelection.contextItems
          : undefined,
        ...succession,
      });
      resetLocal();
      const now = new Date().toISOString();
      onCreated({
        agentSessionId: result.agentSessionId,
        status: "running",
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
        displayName: `${taskTitle} 세션`,
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

  const close = async () => {
    if (pending) return;
    if (uploadUrl) await cancel();
    else resetLocal();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) void close(); }}>
      <DialogPopup
        className="v3-succession-modal max-w-[640px]"
        closeProps={{ "aria-label": "승계 닫기", disabled: pending }}
      >
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">↗</span>
          <DialogTitle>새 세션</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          {error ? (
            <V3ErrorNotice
              className="v3-succession-error"
              message="새 세션을 시작하지 못했습니다."
              detail={error}
            />
          ) : null}
          <div className="v3-succession-context-editor">
            <section>
              <strong>노드 / 에이전트</strong>
              <AgentNodeAssignmentFields presentation="session" agentId={selectedAgentId} nodeId={selectedNodeId} preferredAgentId={resolvedDefaults.agentId} preferredNodeId={resolvedDefaults.nodeId} fallbackToAvailable onAgentIdChange={setSelectedAgentId} onNodeIdChange={setSelectedNodeId} onAgentInfoChange={setSelectedAgent} onError={handleAssignmentError} />
            </section>
            <section>
              <strong>컨텍스트</strong>
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
                          <span key={context.id}>
                            <span aria-hidden="true">{context.icon}</span>
                            <span className="v3-succession-context-label">{context.label}</span>
                          </span>
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
                            {option.label}{option.runNumber === null ? "" : ` · 세션 #${option.runNumber}`}
                          </option>
                        ))}
                      </select>
                      {predecessorId ? <small>이전 세션을 이어 받을 경우 세션을 승계한 것으로 간주됩니다.</small> : null}
                    </span>
                  </label>
                </li>
              </ol>
              <strong>보드 문서</strong>
              <div className="v3-succession-document-options">
                {documentOptions.map((document) => (
                  <label key={document.pageId}>
                    <input
                      type="checkbox"
                      checked={selectedDocumentIds.has(document.pageId)}
                      onChange={() => setSelectedDocumentIds((current) => {
                        const next = new Set(current);
                        if (next.has(document.pageId)) next.delete(document.pageId);
                        else next.add(document.pageId);
                        return next;
                      })}
                    />
                    <span>{document.title}</span>
                  </label>
                ))}
                {documentOptions.length === 0 ? <small>업무에 마운트된 보드 문서가 없습니다.</small> : null}
              </div>
              <label className="flex min-w-0 flex-col gap-2">
                <strong>atom 노드</strong>
                <AtomNodeSelector
                  value={atomNodeId}
                  selectedTitle={atomNodeTitle}
                  disabled={pending}
                  onChange={(nodeId, title) => { setAtomNodeId(nodeId); setAtomNodeTitle(title); }}
                />
              </label>
            </section>
            <label>
              <strong>초기 지시</strong>
              <textarea
                value={initialInstruction}
                disabled={pending}
                rows={4}
                placeholder="세션을 시작하자마자 수행할 지시…"
                onChange={(event) => setInitialInstruction(event.target.value)}
              />
            </label>
            <div className="flex min-w-0 flex-col gap-2">
              {files.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {files.map((file) => (
                    <FileAttachmentPreview
                      key={file.id}
                      file={file.file}
                      status={file.status}
                      onRemove={() => removeFile(file.id)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !selectedNodeId}
                  onClick={() => fileInputRef.current?.click()}
                >
                  파일 첨부
                </Button>
                {isUploading ? <small>업로드 중…</small> : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          <Button variant="ghost" disabled={pending} onClick={() => { void close(); }}>취소</Button>
          <Button disabled={pending || isUploading || contextPending || !selectedNodeId || !selectedAgentId || selectedAgent?.id !== selectedAgentId} onClick={() => { void start(); }}>{pending ? "시작 중…" : isUploading ? "첨부 중…" : contextPending ? "컨텍스트 확인 중…" : "시작"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
