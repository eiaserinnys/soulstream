import { ProjectAtomFields, isProjectAtomValid, type ProjectAtomFieldValue } from "./ProjectContextFormFields";
import {CreationDisclosure} from "./CreationDisclosure";
import {SessionAttachmentFields} from "./SessionAttachmentFields";
import { handleClipboardFiles } from "@seosoyoung/soul-ui/lib/clipboard-files";
import { useCallback, useMemo, useRef, useState, useId } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  reasoningEffortLabel,
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
  type ModelPresetAvailability,
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
  createFolderPageAnchor,
  type PageSessionDefaults,
} from "./folder-workspace-page-api";
import { V3ErrorNotice } from "./V3ErrorNotice";
import { buildSessionContextSelection } from "./session-context-items";
import { useReasoningEffortSelection } from "../hooks/useReasoningEffortSelection";

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
  actions, uploadController, assignment, atomRequest,
  folderTitle,
  folderPageId,
  folderId,
  contextItems,
  documentOptions,
  contextPending,
  predecessorOptions,
  pageDefaults,
  currentSession,
  onClose,
  onCreated,
}: {
  actions?: { createSession: typeof createDashboardSession; createAnchor: typeof createFolderPageAnchor };
  uploadController?: import("@seosoyoung/soul-ui/hooks/useFileUpload").UseFileUploadReturn;
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
  atomRequest?: typeof fetch;
  folderTitle: string;
  folderPageId: string;
  folderId: string | null;
  contextItems: readonly SuccessionContextItem[];
  documentOptions: readonly SuccessionDocumentOption[];
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
  const [inheritCard, setInheritCard] = useState(Boolean(folderPageId));
  const [inheritSummary, setInheritSummary] = useState(Boolean(predecessorId));
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set());
  const [pendingSessionId] = useState(() => crypto.randomUUID());
  const [atomValue, setAtomValue] = useState<ProjectAtomFieldValue>({instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false});
  const {nodeId: atomNodeId, nodeTitle: atomNodeTitle} = atomValue;
  const [initialInstruction, setInitialInstruction] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState(resolvedDefaults.nodeId ?? "");
  const [selectedAgentId, setSelectedAgentId] = useState(resolvedDefaults.agentId ?? "");
  const [selectedAgent, setSelectedAgent] = useState<AgentInfo | null>(null);
  const [selectedModelPreset, setSelectedModelPreset] = useState(
    resolvedDefaults.modelPreset ?? "",
  );
  const [selectedModelPresetInfo, setSelectedModelPresetInfo] =
    useState<ModelPresetAvailability | null>(null);
  const [modelPresetValid, setModelPresetValid] = useState(true);
  const modelPresetSource = useRef<
    "automatic" | "inherited" | "agent" | "explicit" | null
  >(
    resolvedDefaults.modelPreset ? "inherited" : null,
  );
  const effort = useReasoningEffortSelection({
    presetKey: selectedModelPreset
      ? `${selectedNodeId}::${selectedModelPreset}`
      : null,
    preset: selectedModelPresetInfo,
    // Inherited from the predecessor. Kept while the model is unchanged; picking
    // a different model refills that preset's default instead.
    initialEffort: resolvedDefaults.reasoningEffort,
  });
  const effortSelectId = useId();
  const presetHasDefaultEffort = Boolean(selectedModelPresetInfo?.default_effort);
  const [preparedPageAnchor, setPreparedPageAnchor] = useState<Awaited<ReturnType<typeof createFolderPageAnchor>> | null>(null);
  const submitting = useRef(false);
  const completed = useRef(false);
  const atomTrigger = useRef<HTMLButtonElement>(null);
  const [atomDraft, setAtomDraft] = useState<ProjectAtomFieldValue | null>(null);
  const [atomOpen, setAtomOpen] = useState(false);
  const [atomStatus, setAtomStatus] = useState<"loading" | "ready" | "error">("ready");
  const closeAtom = () => { setAtomDraft(null); queueMicrotask(() => atomTrigger.current?.focus()); };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadUrl = selectedNodeId
    ? `/api/attachments/sessions?nodeId=${encodeURIComponent(selectedNodeId)}`
    : "";
  const localUpload = useFileUpload({ uploadUrl: uploadController ? "" : uploadUrl, sessionId: pendingSessionId, folderId });
  const {
    files,
    isUploading,
    isReady,
    addFiles,
    removeFile,
    cancel,
    resetLocal,
    uploadedPaths,
  } = uploadController ?? localUpload;
  const contextSelection = useMemo(() => buildSessionContextSelection({
    inheritCard,
    folderPageId,
    documentPageIds: documentOptions
      .filter((document) => selectedDocumentIds.has(document.pageId))
      .map((document) => document.pageId),
    atomNode: atomNodeId ? { nodeId: atomNodeId, title: atomNodeTitle, depth: atomValue.depth, titlesOnly: atomValue.titlesOnly, mode: atomValue.mode } : null,
    guidance: "",
  }), [atomValue, atomNodeId, atomNodeTitle, documentOptions, inheritCard, selectedDocumentIds, folderPageId]);
  const handleAssignmentError = useCallback((message: string) => {
    console.error("[v3/session-succession] 실행 대상 조회 실패", message);
    setError(message);
  }, []);
  const handleAgentInfoChange = useCallback((agent: AgentInfo | null) => {
    setSelectedAgent(agent);
    if (modelPresetSource.current !== null && modelPresetSource.current !== "agent") return;
    modelPresetSource.current = agent ? "agent" : null;
    setSelectedModelPreset(agent?.default_preset ?? "");
  }, []);
  const handleModelPresetChange = useCallback((value: string) => {
    modelPresetSource.current = "explicit";
    setSelectedModelPreset(value);
  }, []);
  const handleNodeIdChange = useCallback((value: string) => {
    setSelectedNodeId(value);
    setSelectedModelPreset("");
    setSelectedModelPresetInfo(null);
    setModelPresetValid(true);
    modelPresetSource.current = "automatic";
  }, []);

  const start = async () => {
    if (submitting.current || completed.current || contextPending || selectedAgent?.id !== selectedAgentId || !selectedNodeId || !selectedAgentId || !modelPresetValid || !isReady) return;
    if (effort.unsupported) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const pageAnchor = contextSelection.needsPageAnchor
        ? preparedPageAnchor ?? await (actions?.createAnchor ?? createFolderPageAnchor)(api, folderPageId)
        : null;
      if (pageAnchor && !preparedPageAnchor) setPreparedPageAnchor(pageAnchor);
      const succession = buildSuccessionCreateOptions({
        includePageContext: contextSelection.needsPageAnchor,
        inheritSummary,
        pageAnchor,
        predecessorSessionId: predecessorId,
      });
      const attachmentPaths = uploadedPaths.length > 0 ? uploadedPaths : undefined;
      const result = await (actions?.createSession ?? createDashboardSession)({
        queryClient,
        addOptimisticSession: useDashboardStore.getState().addOptimisticSession,
        initialInstruction: appendAttachmentPathNotes(initialInstruction, attachmentPaths),
        attachmentPaths,
        nodeId: selectedNodeId,
        agentId: selectedAgentId,
        agent: selectedAgent,
        modelPreset: selectedModelPreset || null,
        // Only ever the value this form actually offers. Sending an inherited
        // effort across a model change would 422 with no way to fix it here.
        ...(effort.submitValue ? { reasoningEffort: effort.submitValue } : {}),
        folderId: folderId,
        contextItems: contextSelection.contextItems.length > 0
          ? contextSelection.contextItems
          : undefined,
        ...succession,
      });
      completed.current = true;
      resetLocal();
      const now = new Date().toISOString();
      onCreated({
        agentSessionId: result.agentSessionId,
        status: "running",
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
        displayName: `${folderTitle} 세션`,
        nodeId: result.nodeId ?? selectedNodeId,
        agentId: selectedAgentId,
        agentName: selectedAgent?.name ?? selectedAgentId,
        agentPortraitUrl: selectedAgent?.portraitUrl ?? undefined,
        backend: selectedModelPresetInfo?.backend ?? selectedAgent?.backend ?? undefined,
        modelPreset: selectedModelPreset || null,
      });
      onClose();
    } catch (caught) {
      console.error("[v3/session-succession] 세션 시작 실패", caught);
      setError(errorText(caught));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const close = async () => {
    if (submitting.current) return;
    if (atomDraft) { closeAtom(); return; }
    if (uploadUrl) await cancel();
    else resetLocal();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) void close(); }}>
      <DialogPopup
        className="v3-surface v3-succession-modal max-w-[640px]"
        closeProps={{ "aria-label": "승계 닫기", disabled: pending }}
        onKeyDown={event => { if(event.key === "Escape" && atomDraft) { event.preventDefault(); event.stopPropagation(); if(atomOpen) setAtomOpen(false); else closeAtom(); } }}
      >
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">↗</span>
          <DialogTitle>{atomDraft ? "추가 참고 자료" : "새 세션"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          {(error || files.find(file => file.status === "error")?.errorMessage) ? (
            <V3ErrorNotice
              className="v3-succession-error"
              message={error ? "새 세션을 시작하지 못했습니다." : "첨부를 업로드하지 못했습니다."}
              detail={error || files.find(file => file.status === "error")?.errorMessage}
            />
          ) : null}
          {atomDraft ? <div className="v3-succession-context-editor">
            <ProjectAtomFields request={atomRequest} value={atomDraft} disabled={pending} supportsLimit={false}
              selectorOpen={atomOpen} onSelectorOpenChange={setAtomOpen} onSelectorStatusChange={setAtomStatus} onChange={setAtomDraft} />
          </div> : null}
          <div hidden={atomDraft !== null}>
          <fieldset disabled={pending} className="v3-succession-context-editor">
            <div className="v3-form-context"><span>시작할 폴더</span><strong>{folderTitle}</strong></div>
            <label>
              <strong>무엇을 시작할까요?</strong>
              <textarea
                aria-label="초기 지시"
                autoFocus
                value={initialInstruction}
                disabled={pending}
                rows={4}
                placeholder="세션을 시작하자마자 수행할 지시…"
                onChange={(event) => setInitialInstruction(event.target.value)}
                onPaste={event => { if (uploadUrl && !pending) handleClipboardFiles(event, addFiles); }}
              />
            </label>
            <SessionAttachmentFields files={files} pending={pending} nodeId={selectedNodeId} isUploading={isUploading} addFiles={addFiles} removeFile={removeFile}/>

            <CreationDisclosure title="실행 환경" invalid={!modelPresetValid || effort.unsupported || !selectedNodeId || !selectedAgentId} summary={`${selectedNodeId || "노드 선택"} / ${selectedAgent?.name ?? "에이전트 선택"} / ${selectedModelPreset || "기본 모델"}`}>
              <section>
              <AgentNodeAssignmentFields data={assignment}
                presentation="session"
                disabled={pending}
                agentId={selectedAgentId}
                nodeId={selectedNodeId}
                modelPreset={selectedModelPreset}
                preferredAgentId={resolvedDefaults.agentId}
                preferredNodeId={resolvedDefaults.nodeId}
                fallbackToAvailable
                onAgentIdChange={setSelectedAgentId}
                onNodeIdChange={handleNodeIdChange}
                onModelPresetChange={handleModelPresetChange}
                onAgentInfoChange={handleAgentInfoChange}
                onModelPresetInfoChange={setSelectedModelPresetInfo}
                onModelPresetValidityChange={setModelPresetValid}
                onError={handleAssignmentError}
              />
              {effort.options.length > 0 ? (
                <>
                  <label htmlFor={effortSelectId}>추론 강도</label>
                  <select
                    id={effortSelectId}
                    aria-label="추론 강도 선택"
                    value={effort.effective ?? ""}
                    onChange={(event) => effort.setSelected(event.target.value || null)}
                  >
                    {/* An unusable carry-over stays the selected value so the box
                        shows what is actually wrong — and so choosing 기본값 사용
                        is a real change event rather than a no-op. */}
                    {effort.unsupported ? (
                      <option value={effort.selected ?? ""}>
                        {reasoningEffortLabel(effort.selected ?? "")} (지원 안 함)
                      </option>
                    ) : null}
                    {/* "Send nothing, let the preset default apply". It must stay
                        available while the preset has no default of its own,
                        otherwise picking a level is a one-way door. */}
                    {effort.unsupported || !presetHasDefaultEffort ? (
                      <option value="">
                        {effort.unsupported ? "기본값 사용" : "기본값"}
                      </option>
                    ) : null}
                    {effort.options.map((option) => (
                      <option key={option} value={option}>
                        {reasoningEffortLabel(option)}
                      </option>
                    ))}
                  </select>

                </>
              ) : null}
              {effort.unsupported && selectedModelPresetInfo !== null ? (
                <small role="alert" data-testid="succession-effort-unsupported">
                  {effort.options.length > 0
                    ? `이어받은 추론 강도 “${reasoningEffortLabel(effort.selected ?? "")}”를 이 모델에서는 쓸 수 없습니다. 다른 강도를 고르거나 기본값으로 시작하세요.`
                    : `이 모델이 광고한 추론 강도 목록이 없어 “${reasoningEffortLabel(effort.selected ?? "")}”를 그대로 쓸 수 없습니다. 기본값으로 시작하세요.`}
                  {" "}
                  <button
                    type="button"
                    data-testid="succession-effort-use-default"
                    onClick={() => effort.setSelected(null)}
                  >
                    기본값 사용
                  </button>
                </small>
              ) : null}
              </section>
            </CreationDisclosure>
            <CreationDisclosure title="함께 전달할 자료" summary={<span>{inheritCard ? "폴더 정보" : "폴더 정보 제외"}{inheritSummary ? " / 이전 세션 포함" : ""}{selectedDocumentIds.size ? ` / 문서 ${selectedDocumentIds.size}개` : ""}{atomNodeId ? " / 추가 참고 자료" : ""}</span>}>
              <section>
              <ol>
                <li>
                  <label>
                    <input
                      type="checkbox"
                      aria-label="카드 본문과 컨텍스트 포함"
                      checked={inheritCard}
                      disabled={!folderPageId}
                      onChange={(event) => setInheritCard(event.target.checked)}
                    />
                    <span>
                      <strong>폴더 정보</strong>
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
                {documentOptions.length === 0 ? <small>폴더에 마운트된 보드 문서가 없습니다.</small> : null}
              </div>
              <label className="flex min-w-0 flex-col gap-2">
                <strong>추가 참고 자료</strong>
                <Button ref={atomTrigger} variant="outline" disabled={pending} onClick={() => {
                  setAtomDraft({ ...atomValue }); setAtomStatus("loading"); setAtomOpen(true);
                }}>{atomNodeTitle || "atom에서 추가"}</Button>
                {atomNodeId ? <Button variant="ghost" disabled={pending} onClick={() => { setAtomValue({instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false}); }}>제거</Button> : null}
              </label>
              </section>
            </CreationDisclosure>
          </fieldset>
          </div>
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          {atomDraft ? <>
            <Button variant="ghost" onClick={closeAtom}>취소</Button>
            <Button disabled={!isProjectAtomValid(atomDraft) || atomOpen || atomStatus !== "ready"} onClick={() => {
              setAtomValue(atomDraft); closeAtom();
            }}>자료 추가</Button>
          </> : <>
          <p className="v3-form-submit-note">시작하면 선택한 환경에서 실행합니다</p>
          <Button variant="ghost" disabled={pending} onClick={() => { void close(); }}>취소</Button>
          <Button
            disabled={
              pending
              || isUploading
              || !isReady
              || contextPending
              || !selectedNodeId
              || !selectedAgentId
              || selectedAgent?.id !== selectedAgentId
              || !modelPresetValid
              // Keep the button state and the guard in start() on one predicate,
              // otherwise an unusable carry-over reads as a dead button.
              || effort.unsupported
            }
            onClick={() => { void start(); }}
          >
            {pending ? "시작 중…" : isUploading ? "첨부 중…" : contextPending ? "컨텍스트 확인 중…" : "세션 시작"}
          </Button>
          </>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
