import { useTranslation } from "react-i18next";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";
import { appendAttachmentPathNotes } from "../../../packages/wire-schema/src/attachment_path_notes";
import { NEW_REFERENCE, ReferencePicker, ReferenceRows, type ReferenceDraft } from "./FolderContextParts";
import { ArrowUpRight, Plus } from "lucide-react";
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
  Switch,
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
  kind?: "guidance" | "atom" | "page";
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
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
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
  const atomTrigger = useRef<HTMLElement | null>(null);
  const [atomDraft, setAtomDraft] = useState<{ index: number | null; value: ReferenceDraft } | null>(null);
  const [atomOpen, setAtomOpen] = useState(false);
  const [atomStatus, setAtomStatus] = useState<"loading" | "ready" | "error">("ready");
  const openAtom = (index: number | null, element: HTMLElement) => {
    atomTrigger.current = element;
    setAtomStatus(index === null ? "loading" : "ready");
    setAtomOpen(index === null);
    setAtomDraft({ index, value: index === null ? NEW_REFERENCE : references[index] });
  };
  const closeAtom = () => { setAtomDraft(null); queueMicrotask(() => atomTrigger.current?.focus()); };
  const closeNodeList = () => {
    setAtomOpen(false);
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-slot="dialog-popup"] [data-slot="atom-node-selector-trigger"]')?.focus());
  };
  const confirmAtom = () => {
    if (!atomDraft) return;
    const duplicate = references.findIndex((item) => item.instance === atomDraft.value.instance && item.nodeId === atomDraft.value.nodeId);
    const next = references.filter((_, index) => index !== atomDraft.index || duplicate === atomDraft.index);
    const target = duplicate >= 0 ? next.indexOf(references[duplicate]) : atomDraft.index === null ? -1 : next.indexOf(references[atomDraft.index]);
    if (target >= 0) next[target] = atomDraft.value; else next.push(atomDraft.value);
    setReferences(next);
    closeAtom();
  };
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
    atomNodes: references.map((reference) => ({ nodeId: reference.nodeId, title: reference.nodeTitle, depth: reference.depth, titlesOnly: reference.titlesOnly, mode: reference.mode })),
    guidance: "",
  }), [references, documentOptions, inheritCard, selectedDocumentIds, folderPageId]);
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

  const environmentSummary = [
    selectedAgent?.name ?? (selectedAgentId || t("sessions.selectAgent")),
    selectedNodeId || t("sessions.selectNode"),
    selectedModelPresetInfo?.label ?? (selectedModelPreset || t("sessions.defaultModel")),
  ].join(" · ");
  const contextKinds = contextItems.map((item) => item.kind);
  const referenceCount = contextKinds.filter((kind) => kind === "atom").length;
  const documentCount = contextKinds.filter((kind) => kind === "page").length;
  const folderContextMeta = [
    contextKinds.includes("guidance") ? t("sessions.contextGuidance") : null,
    referenceCount ? t("sessions.referenceCount", { count: referenceCount }) : null,
    documentCount ? t("sessions.documentCount", { count: documentCount }) : null,
    pageDefaults ? t("sessions.contextDefaults") : null,
  ].filter(Boolean).join(" · ") || t("sessions.noLinkedContext");
  const materialsSummary = [
    inheritCard ? t("sessions.folderContext") : null,
    inheritSummary && predecessorId ? t("sessions.previousSession") : null,
    selectedDocumentIds.size ? t("sessions.documentCount", { count: selectedDocumentIds.size }) : null,
    references.length ? t("sessions.referenceCount", { count: references.length }) : null,
  ].filter(Boolean).join(" · ") || t("sessions.materialsNone");

  return (
    <Dialog open onOpenChange={(open, details) => {
      if (open || pending) return;
      if (!atomDraft) { void close(); return; }
      details.cancel();
      if (details.reason === "escape-key" && atomOpen) closeNodeList(); else closeAtom();
    }}>
      <DialogPopup
        className="v3-surface v3-succession-modal max-w-[640px]"
        {...(returnFocusRef ? { finalFocus: () => completed.current ? true : returnFocusRef.current } : {})}
        closeProps={{ "aria-label": t("sessions.closeSuccession"), disabled: pending }}
      >
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">{atomDraft ? <Plus /> : <ArrowUpRight />}</span>
          <DialogTitle>{atomDraft ? atomDraft.index === null ? t("folders.settings.addReference") : t("folders.settings.editReference") : t("sessions.newSession")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          {(error || files.find(file => file.status === "error")?.errorMessage) ? (
            <V3ErrorNotice
              className="v3-succession-error"
              message={error ? t("sessions.startFailed") : t("sessions.uploadFailed")}
              detail={error || files.find(file => file.status === "error")?.errorMessage}
            />
          ) : null}
          {atomDraft ? <ReferencePicker request={atomRequest} value={atomDraft.value} disabled={pending}
            selectorOpen={atomOpen} onSelectorOpenChange={setAtomOpen} onSelectorStatusChange={setAtomStatus}
            onChange={(value) => setAtomDraft({ ...atomDraft, value })} /> : null}
          <div hidden={atomDraft !== null}>
          <fieldset disabled={pending} className="v3-succession-context-editor">
            <div className="v3-form-context"><span>{t("sessions.targetFolder")}</span><strong>{folderTitle}</strong></div>
            <section className="v3-session-request">
              <label className="v3-session-request-field">
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
            </section>

            <CreationDisclosure title={t("sessions.environment")} invalid={!modelPresetValid || effort.unsupported || !selectedNodeId || !selectedAgentId} summary={environmentSummary}>
              <section className="v3-succession-environment">
              <AgentNodeAssignmentFields data={assignment}
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
                <div className="v3-succession-assignment" role="group" aria-label={t("sessions.reasoningEffort")} aria-describedby={effortNotice ? effortNoticeId : undefined}>
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
            <CreationDisclosure title={t("sessions.sharedMaterials")} summary={materialsSummary}>
              <div className="v3-session-materials">
                <label className="v3-material-toggle">
                  <span><strong>{t("sessions.folderContext")}</strong><small>{folderContextMeta}</small></span>
                  <Switch aria-label={t("sessions.includeCardContext")} checked={inheritCard} disabled={!folderPageId} onCheckedChange={setInheritCard} />
                </label>
                <div className="v3-material">
                  <label className="v3-material-toggle">
                    <span><strong>{t("sessions.previousSession")}</strong><small>{predecessorId ? t("sessions.successionDescription") : t("sessions.noPreviousSession")}</small></span>
                    <Switch aria-label={t("sessions.continuePrevious")} checked={inheritSummary && Boolean(predecessorId)} disabled={!predecessorId} onCheckedChange={setInheritSummary} />
                  </label>
                  {inheritSummary && predecessorOptions.length > 0 ? <CatalogSelectionField className="v3-assignment-field" label={t("sessions.previousSession")} labelClassName="sr-only" ariaLabel={t("sessions.choosePrevious")}
                    value={selectedPredecessorIndex < 0 ? "" : String(selectedPredecessorIndex)}
                    selectedLabel={predecessorChoices[selectedPredecessorIndex]?.label ?? t("sessions.noPreviousSession")}
                    options={predecessorChoices}
                    onValueChange={(value) => {
                      const option = predecessorOptions[Number(value)];
                      setSelectedPredecessorId(option?.sessionId ?? null);
                    }} /> : null}
                </div>
                {documentOptions.length > 0 ? <div className="v3-material">
                  <strong>{t("sessions.boardDocuments")}</strong>
                  {documentOptions.map((document) => (
                    <label key={document.pageId} className="v3-material-toggle">
                      <span><span>{document.title}</span></span>
                      <Switch aria-label={document.title} checked={selectedDocumentIds.has(document.pageId)} onCheckedChange={() => setSelectedDocumentIds((current) => {
                        const next = new Set(current);
                        if (next.has(document.pageId)) next.delete(document.pageId);
                        else next.add(document.pageId);
                        return next;
                      })} />
                    </label>
                  ))}
                </div> : null}
                <div className="v3-material">
                  <div className="v3-context-section-head">
                    <strong>{t("sessions.references")}</strong>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={(event) => openAtom(null, event.currentTarget)}>
                      <Plus aria-hidden="true" />{t("sessions.addReference")}
                    </Button>
                  </div>
                  <ReferenceRows own={references.map((reference) => ({ ...reference, blockId: null }))} disabled={pending}
                    onEdit={(index, element) => openAtom(index, element)}
                    onRemove={(index) => setReferences(references.filter((_, i) => i !== index))} />
                </div>
              </div>
            </CreationDisclosure>
          </fieldset>
          </div>
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          {atomDraft ? <>
            <Button variant="ghost" onClick={closeAtom}>{t("sessions.cancel")}</Button>
            <Button disabled={!atomDraft.value.nodeId.trim() || atomOpen || atomStatus !== "ready"} onClick={confirmAtom}>
              {atomDraft.index === null ? t("folders.settings.add") : t("folders.common.confirm")}
            </Button>
          </> : <>
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
