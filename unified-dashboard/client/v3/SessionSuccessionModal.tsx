import { useTranslation } from "react-i18next";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import { appendAttachmentPathNotes } from "../../../packages/wire-schema/src/attachment_path_notes";
import { ProjectAtomFields, isProjectAtomValid, type ProjectAtomFieldValue } from "./ProjectContextFormFields";
import {CreationDisclosure} from "./CreationDisclosure";
import {SessionAttachmentFields} from "./SessionAttachmentFields";
import { handleClipboardFiles } from "@seosoyoung/soul-ui/lib/clipboard-files";
import { useId, useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  useFileUpload,
  useDashboardStore,
  type AgentInfo,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { reasoningEffortLabel } from "@seosoyoung/soul-ui/lib/reasoning-effort";
import type { ModelPresetAvailability } from "@seosoyoung/soul-ui/lib/model-preset-availability";

import { createDashboardSession } from "../lib/session-create";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
import { CatalogSelectionField } from "../components/CatalogSelectionField";
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
  returnFocusRef,
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
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onCreated(session: SessionSummary): void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const formatNumber = new Intl.NumberFormat(language).format;
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  const effortTrigger = useRef<HTMLButtonElement>(null);
  useTextareaAutoHeight(textarea, initialInstruction, 14);
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
    console.error("[v3/session-succession] 실행 대상 조회 실패", message); // i18n-ignore: diagnostic log
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
        displayName: t("sessions.createdSessionTitle", { folder: folderTitle }),
        nodeId: result.nodeId ?? selectedNodeId,
        agentId: selectedAgentId,
        agentName: selectedAgent?.name ?? selectedAgentId,
        agentPortraitUrl: selectedAgent?.portraitUrl ?? undefined,
        backend: selectedModelPresetInfo?.backend ?? selectedAgent?.backend ?? undefined,
        modelPreset: selectedModelPreset || null,
      });
      onClose();
    } catch (caught) {
      console.error("[v3/session-succession] 세션 시작 실패", caught); // i18n-ignore: diagnostic log
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

  const effortNoticeId = useId();
  const effortNotice = effort.unsupported && selectedModelPresetInfo !== null ? <span data-testid="succession-effort-unsupported">
    <span data-v3-selectable-content="true">{effort.options.length > 0
      ? t("sessions.unsupportedEffort", { effort: reasoningEffortLabel(effort.selected ?? "") })
      : t("sessions.unknownEffort", { effort: reasoningEffortLabel(effort.selected ?? "") })}</span>{" "}
    <Button type="button" variant="outline" size="xs" className="align-middle" data-testid="succession-effort-use-default" onClick={() => {
      (effortTrigger.current ?? textarea.current)?.focus();
      effort.setSelected(null);
    }}>{t("sessions.useDefault")}</Button>
  </span> : null;
  const effortOptions = [
    ...(effort.unsupported ? [{ value: effort.selected ?? "", label: t("sessions.unsupportedEffortLabel", { effort: reasoningEffortLabel(effort.selected ?? "") }) }] : []),
    ...(effort.unsupported || !presetHasDefaultEffort ? [{ value: "", label: effort.unsupported ? t("sessions.useDefault") : t("sessions.default") }] : []),
    ...effort.options.map((option) => ({ value: option, label: reasoningEffortLabel(option) })),
  ];
  const predecessorChoices = predecessorOptions.map((option, index) => ({
    value: String(index), label: `${option.label ?? t("sessions.untitledSession")}${option.runNumber === null ? "" : ` · ${t("sessions.sessionNumber", { number: formatNumber(option.runNumber) })}`}`,
  }));

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) void close(); }}>
      <DialogPopup
        className="v3-surface v3-succession-modal max-w-[640px]"
        {...(returnFocusRef ? { finalFocus: () => completed.current ? true : returnFocusRef.current } : {})}
        closeProps={{ "aria-label": t("sessions.closeSuccession"), disabled: pending }}
        onKeyDown={event => { if(event.key === "Escape" && atomDraft) { event.preventDefault(); event.stopPropagation(); if(atomOpen) setAtomOpen(false); else closeAtom(); } }}
      >
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">↗</span>
          <DialogTitle>{atomDraft ? t("sessions.referenceMaterial") : t("sessions.newSession")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          {(error || files.find(file => file.status === "error")?.errorMessage) ? (
            <V3ErrorNotice
              className="v3-succession-error"
              message={error ? t("sessions.startFailed") : t("sessions.uploadFailed")}
              detail={error || files.find(file => file.status === "error")?.errorMessage}
            />
          ) : null}
          {atomDraft ? <div className="v3-succession-context-editor">
            <ProjectAtomFields request={atomRequest} value={atomDraft} disabled={pending} supportsLimit={false}
              selectorOpen={atomOpen} onSelectorOpenChange={setAtomOpen} onSelectorStatusChange={setAtomStatus} onChange={setAtomDraft} />
          </div> : null}
          <div hidden={atomDraft !== null}>
          <fieldset disabled={pending} className="v3-succession-context-editor">
            <div className="v3-form-context"><span>{t("sessions.targetFolder")}</span><strong>{folderTitle}</strong></div>
            <label className="v3-creation-text-field">
              <strong>{t("sessions.startPrompt")}</strong>
              <textarea
                ref={textarea}
                className="v3-creation-request max-h-[120px]"
                aria-label={t("sessions.initialInstruction")}
                autoFocus
                value={initialInstruction}
                disabled={pending}
                rows={1}
                placeholder={t("sessions.initialInstructionPlaceholder")}
                onChange={(event) => setInitialInstruction(event.target.value)}
                onPaste={event => { if (uploadUrl && !pending) handleClipboardFiles(event, addFiles); }}
              />
            </label>
            <SessionAttachmentFields files={files} pending={pending} nodeId={selectedNodeId} isUploading={isUploading} addFiles={addFiles} removeFile={removeFile}/>

            <CreationDisclosure title={t("sessions.environment")} invalid={!modelPresetValid || effort.unsupported || !selectedNodeId || !selectedAgentId} summary={`${selectedNodeId || t("sessions.selectNode")} / ${selectedAgent?.name ?? t("sessions.selectAgent")} / ${selectedModelPreset || t("sessions.defaultModel")}`}>
              <section className="v3-succession-assignment">
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
                <div role="group" aria-label={t("sessions.reasoningEffort")} aria-describedby={effortNotice ? effortNoticeId : undefined}>
                <CatalogSelectionField className="v3-assignment-field" label={t("sessions.reasoningEffort")} ariaLabel={t("sessions.selectReasoningEffort")}
                  triggerRef={effortTrigger}
                  value={effort.effective ?? ""} options={effortOptions}
                  selectedLabel={effortOptions.find((option) => option.value === (effort.effective ?? ""))?.label ?? ""}
                  onValueChange={(value) => effort.setSelected(value || null)} />
                </div>
              ) : null}
              {effortNotice ? <small id={effortNoticeId} className="v3-succession-effort-notice" role="alert">{effortNotice}</small> : null}
              </section>
            </CreationDisclosure>
            <CreationDisclosure title={t("sessions.sharedMaterials")} summary={<span>{inheritCard ? t("sessions.folderInfo") : t("sessions.excludeFolderInfo")}{inheritSummary ? t("sessions.includePrevious") : ""}{selectedDocumentIds.size ? t("sessions.includedDocuments", { count: formatNumber(selectedDocumentIds.size) }) : ""}{atomNodeId ? t("sessions.includeReferences") : ""}</span>}>
              <section>
              <ol>
                <li>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t("sessions.includeCardContext")}
                      checked={inheritCard}
                      disabled={!folderPageId}
                      onChange={(event) => setInheritCard(event.target.checked)}
                    />
                    <span>
                      <strong>{t("sessions.folderInfo")}</strong>
                      <span className="v3-succession-context-chips">
                        {contextItems.map((context) => (
                          <span key={context.id}>
                            <span aria-hidden="true">{context.icon}</span>
                            <span className="v3-succession-context-label">{context.label}</span>
                          </span>
                        ))}
                        {contextItems.length === 0 ? <small>{t("sessions.noLinkedContext")}</small> : null}
                      </span>
                    </span>
                  </label>
                </li>
                <li>
                  <div className="v3-succession-previous">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={t("sessions.continuePrevious")}
                        checked={inheritSummary}
                        disabled={!predecessorId}
                        onChange={(event) => setInheritSummary(event.target.checked)}
                      />
                      <span>
                        <strong>{t("sessions.previousSession")}</strong>
                        {predecessorId ? <small>{t("sessions.successionDescription")}</small> : null}
                      </span>
                    </label>
                    <div className="v3-succession-previous-field">
                      <CatalogSelectionField className="v3-assignment-field" label={t("sessions.previousSession")} ariaLabel={t("sessions.choosePrevious")}
                        value={selectedPredecessorIndex < 0 ? "" : String(selectedPredecessorIndex)}
                        disabled={!inheritSummary || predecessorOptions.length === 0}
                        selectedLabel={predecessorChoices[selectedPredecessorIndex]?.label ?? t("sessions.noPreviousSession")}
                        options={predecessorChoices.length ? predecessorChoices : [{ value: "", label: t("sessions.noPreviousSession") }]}
                        onValueChange={(value) => {
                          const option = predecessorOptions[Number(value)];
                          setSelectedPredecessorId(option?.sessionId ?? null);
                        }} />
                    </div>
                  </div>
                </li>
              </ol>
              <strong>{t("sessions.boardDocuments")}</strong>
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
                {documentOptions.length === 0 ? <small>{t("sessions.noMountedDocuments")}</small> : null}
              </div>
              <label className="flex min-w-0 flex-col gap-2">
                <strong>{t("sessions.referenceMaterial")}</strong>
                <Button ref={atomTrigger} variant="outline" disabled={pending} onClick={() => {
                  setAtomDraft({ ...atomValue }); setAtomStatus("loading"); setAtomOpen(true);
                }}>{atomNodeTitle || t("sessions.addFromAtom")}</Button>
                {atomNodeId ? <Button variant="ghost" disabled={pending} onClick={() => { setAtomValue({instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false}); }}>{t("sessions.remove")}</Button> : null}
              </label>
              </section>
            </CreationDisclosure>
          </fieldset>
          </div>
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          {atomDraft ? <>
            <Button variant="ghost" onClick={closeAtom}>{t("sessions.cancel")}</Button>
            <Button disabled={!isProjectAtomValid(atomDraft) || atomOpen || atomStatus !== "ready"} onClick={() => {
              setAtomValue(atomDraft); closeAtom();
            }}>{t("sessions.addReferences")}</Button>
          </> : <>
          <p className="v3-form-submit-note">{t("sessions.startNote")}</p>
          <Button variant="ghost" disabled={pending} onClick={() => { void close(); }}>{t("sessions.cancel")}</Button>
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
            {pending ? t("sessions.starting") : isUploading ? t("sessions.attaching") : contextPending ? t("sessions.checkingContext") : t("sessions.startSession")}
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
