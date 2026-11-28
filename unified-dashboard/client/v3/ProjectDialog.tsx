import { folderErrorText } from "./folder-messages";
import { dictionaries } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  FrameLoading,
  Input,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";
import { useTextareaAutoHeight } from "@seosoyoung/soul-ui/components/chat/useTextareaAutoHeight";

import { AgentNodeAssignmentFields, type AssignmentData } from "./AgentNodeAssignmentFields";
import {
  ContextSourceMark,
  ContextSourceToggle,
  NEW_REFERENCE,
  ReferencePicker,
  ReferenceRows,
  useExecutionEnvironmentLabel,
  type ReferenceDraft,
} from "./FolderContextParts";
import {
  emptyProjectFormValue,
  isProjectFormValid,
  projectFormValueFromDetails,
  type ContextSource,
  type ProjectFormValue,
} from "./project-form-model";
import { fetchProjectPageDetails, type ProjectPageDetails } from "./project-page-details";
import { descriptionMarkdown } from "./folder-workspace-run-model";
import { useProjectContextInheritance } from "./use-project-context-inheritance";
import type { ProjectContextInheritance } from "./project-context-inheritance";
import type { ProjectContextSaveSession } from "./project-form-actions";

export type ProjectDialogTarget =
  | { mode: "create"; parentFolderId: string | null; parentName: string | null }
  | { mode: "edit"; folder: CatalogFolder };

interface ReferenceEditor { index: number | null; value: ReferenceDraft }

const EMPTY_DETAILS: ProjectPageDetails = { guidance: [], atomReferences: [], sessionDefaults: [] };

export function ProjectDialog({
  request, assignment, folders, initialEditor,
  target,
  createLabel,
  onClose,
  onCreateIdentity,
  onRename,
  onSaveContext,
  onSaved,
}: {
  request?: typeof fetch;
  assignment?: AssignmentData;
  folders: readonly CatalogFolder[];
  initialEditor?: "reference-add" | "reference-edit";
  target: ProjectDialogTarget | null;
  createLabel?: string;
  onClose(): void;
  onCreateIdentity(title: string, parentFolderId: string | null): Promise<CatalogFolder>;
  onRename(folder: CatalogFolder, title: string): Promise<void>;
  onSaveContext(pageId: string, previous: ProjectPageDetails, value: ProjectFormValue, attempt?: ProjectContextSaveSession): Promise<void>;
  onSaved(folder: CatalogFolder): void;
}) {
  const { t } = useTranslation();
  const attempt = useRef<ProjectContextSaveSession>({});
  const busy = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [editor, setEditor] = useState<ReferenceEditor | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">("ready");
  const [value, setValue] = useState<ProjectFormValue>(() => emptyProjectFormValue());
  const [previous, setPrevious] = useState<ProjectPageDetails>(EMPTY_DETAILS);
  const [createdFolder, setCreatedFolder] = useState<CatalogFolder | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [modelValid, setModelValid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<{ key: string; cause: unknown } | null>(null);
  const parentFolderId = target?.mode === "create" ? target.parentFolderId : target?.folder.parentFolderId ?? null;
  const parentName = target?.mode === "create"
    ? target.parentName
    : folders.find((folder) => folder.id === parentFolderId)?.name ?? null;
  const inheritance = useProjectContextInheritance({ folderId: parentFolderId ?? "", folders, request });
  const inherited = inheritance.status === "ready" ? inheritance.data : null;
  const effectiveFolder = target?.mode === "edit" ? target.folder : createdFolder;

  const openEditor = (next: ReferenceEditor, element: HTMLElement | null) => {
    trigger.current = element;
    setTreeStatus("ready");
    setTreeOpen(next.index === null);
    setEditor(next);
  };
  const closeEditor = () => { setEditor(null); queueMicrotask(() => trigger.current?.focus()); };
  const closeNodeList = () => {
    setTreeOpen(false);
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-slot="dialog-popup"] [data-slot="atom-node-selector-trigger"]')?.focus());
  };

  useEffect(() => {
    attempt.current = {};
    busy.current = false;
    setEditor(null);
    setCreatedFolder(null);
    setError(null);
    setDialogError(null);
    setLoadFailed(false);
    setModelValid(true);
    if (!target) return;
    if (target.mode === "create") {
      setPrevious(EMPTY_DETAILS);
      setValue(emptyProjectFormValue());
      setLoading(false);
      if (initialEditor === "reference-add") openEditor({ index: null, value: NEW_REFERENCE }, null);
      return;
    }
    let active = true;
    setLoading(true);
    const pageId = target.folder.projectPageId ?? target.folder.id;
    void fetchProjectPageDetails(pageId, request).then((snapshot) => {
      if (!active) return;
      const loaded = projectFormValueFromDetails(target.folder.name, descriptionMarkdown(snapshot.page, snapshot.blocks), snapshot);
      setPrevious(snapshot);
      setValue(loaded);
      if (initialEditor === "reference-add") openEditor({ index: null, value: NEW_REFERENCE }, null);
      if (initialEditor === "reference-edit" && loaded.atomReferences[0]) openEditor({ index: 0, value: loaded.atomReferences[0] }, null);
    }).catch((cause: unknown) => {
      if (active) {
        setLoadFailed(true);
        setDialogError({ key: "folders.dialog.loadError", cause });
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [initialEditor, request, target]);

  const visibleError = dialogError
    ? t(dialogError.key, { detail: folderErrorText(t, dialogError.cause) }) : error;
  const newFolderLabel = createLabel && createLabel !== dictionaries.ko.folders.common.newFolder
    ? createLabel : t("folders.common.newFolder");
  const creating = target?.mode === "create" && !createdFolder;
  const title = editor
    ? editor.index === null ? t("folders.settings.addReference") : t("folders.settings.editReference")
    : creating ? newFolderLabel : t("folders.dialog.title");
  const canSubmit = !loadFailed && isProjectFormValid(value)
    && (value.sessionDefaults.source === "inherit" || modelValid);

  const confirmEditor = () => {
    if (!editor) return;
    const duplicate = value.atomReferences.findIndex((item) => item.instance === editor.value.instance && item.nodeId === editor.value.nodeId);
    const index = duplicate >= 0 ? duplicate : editor.index;
    const kept = index === null ? null : value.atomReferences[index];
    const item = { ...kept, ...editor.value, blockId: kept?.blockId ?? null, draftId: kept?.draftId ?? crypto.randomUUID() };
    const atomReferences = value.atomReferences.filter((_, i) => i !== editor.index || editor.index === index);
    if (kept) atomReferences[atomReferences.indexOf(kept)] = item;
    else atomReferences.push(item);
    setValue({ ...value, atomReferences });
    closeEditor();
  };

  const submit = async () => {
    if (!target || busy.current || !canSubmit || editor) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setDialogError(null);
    try {
      let folder = effectiveFolder;
      if (!folder) {
        folder = await onCreateIdentity(value.title.trim(), target.mode === "create" ? target.parentFolderId : null);
        setCreatedFolder(folder);
      } else if (folder.name !== value.title.trim()) {
        await onRename(folder, value.title.trim());
        folder = { ...folder, name: value.title.trim() };
      }
      await onSaveContext(folder.projectPageId ?? folder.id, previous, value, attempt.current);
      onSaved(folder);
      onClose();
    } catch (cause) {
      setDialogError({ key: "folders.dialog.saveError", cause });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open, details) => {
      if (open || busy.current) return;
      if (!editor) { onClose(); return; }
      details.cancel();
      if (details.reason === "escape-key" && treeOpen) closeNodeList(); else closeEditor();
    }}>
      <DialogPopup className="v3-surface v3-succession-modal v3-folder-settings max-w-[640px]" closeProps={{ disabled: pending }}>
        <DialogHeader className="v3-succession-head">
          <span aria-hidden="true">{editor ? <Plus /> : <SlidersHorizontal />}</span>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="v3-succession-body" scrollFade={false}>
          {editor ? <ReferencePicker request={request} value={editor.value} disabled={pending}
            selectorOpen={treeOpen} onSelectorOpenChange={setTreeOpen} onSelectorStatusChange={setTreeStatus}
            onChange={(next) => setEditor({ ...editor, value: next })} /> : null}
          <div hidden={editor !== null}>
            {loading ? <FrameLoading label={t("folders.dialog.loading")} /> : loadFailed ? null : (
              <FolderSettingsForm key={target?.mode === "edit" ? target.folder.id : "create"}
                value={value} disabled={pending} parentName={parentName} inherited={inherited}
                assignment={assignment} onChange={setValue} onModelValidityChange={setModelValid} onError={setError}
                onEditReference={(index, element) => openEditor(index === null
                  ? { index: null, value: NEW_REFERENCE }
                  : { index, value: value.atomReferences[index] }, element)} />
            )}
          </div>
          {visibleError ? <p className="v3-project-star-error" role="alert" data-v3-selectable-content="true">{visibleError}</p> : null}
        </DialogPanel>
        <DialogFooter className="v3-succession-footer">
          {editor ? <>
            <Button variant="ghost" onClick={closeEditor}>{t("folders.common.cancel")}</Button>
            <Button disabled={treeOpen || treeStatus !== "ready" || !editor.value.nodeId.trim()} onClick={confirmEditor}>
              {editor.index === null ? t("folders.settings.add") : t("folders.common.confirm")}
            </Button>
          </> : <>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>{t("folders.common.cancel")}</Button>
            <Button type="button" disabled={loading || pending || !canSubmit} onClick={() => { void submit(); }}>
              {pending ? t("folders.common.saving") : creating ? t("folders.common.create") : t("folders.common.save")}
            </Button>
          </>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function GrowingTextarea({ value, label, placeholder, disabled, onChange }: {
  value: string; label: string; placeholder?: string; disabled: boolean; onChange(value: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useTextareaAutoHeight(ref, value, 14);
  return <textarea ref={ref} rows={1} className="v3-creation-request" aria-label={label} placeholder={placeholder}
    value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
}

function FolderSettingsForm({ value, disabled, parentName, inherited, assignment, onChange, onModelValidityChange, onError, onEditReference }: {
  value: ProjectFormValue;
  disabled: boolean;
  parentName: string | null;
  inherited: ProjectContextInheritance | null;
  assignment?: AssignmentData;
  onChange(value: ProjectFormValue): void;
  onModelValidityChange(valid: boolean): void;
  onError(message: string): void;
  onEditReference(index: number | null, trigger: HTMLElement): void;
}) {
  const { t } = useTranslation();
  const inheritedGuidance = inherited?.guidance ?? [];
  const inheritedGuidanceText = inheritedGuidance.map((item) => item.text).join("\n\n");
  const inheritedDefaults = inherited?.sessionDefaults.at(-1) ?? null;
  const inheritedDefaultsLabel = useExecutionEnvironmentLabel(inheritedDefaults, assignment);
  const inheritedReferences = useMemo(() => (inherited?.atomReferences ?? [])
    .filter((reference) => !value.atomReferences.some((own) => own.instance === reference.instance && own.nodeId === reference.nodeId))
    .map((reference) => ({
      key: `${reference.source.pageId}:${reference.blockId}`, nodeTitle: reference.nodeTitle,
      depth: reference.depth, titlesOnly: reference.titlesOnly, sourceName: reference.source.folderName,
    })), [inherited, value.atomReferences]);
  const setGuidanceSource = (source: ContextSource) => onChange({ ...value, guidance: { ...value.guidance, source } });
  const setDefaultsSource = (source: ContextSource) => {
    const current = value.sessionDefaults;
    const prefill = source === "own" && !current.nodeId && inheritedDefaults
      ? { nodeId: inheritedDefaults.nodeId ?? "", agentId: inheritedDefaults.agentId ?? "", modelPreset: inheritedDefaults.modelPreset ?? "" }
      : {};
    onChange({ ...value, sessionDefaults: { ...current, ...prefill, source } });
  };
  const defaults = value.sessionDefaults;
  const nothingInherited = <p className="v3-inherited-value" data-empty="true">{t("folders.settings.nothingInherited")}</p>;
  return <fieldset className="v3-succession-context-editor" disabled={disabled} data-testid="v3-project-dialog-form">
    {parentName ? <div className="v3-form-context"><span>{t("folders.settings.parentFolder")}</span><strong>{parentName}</strong></div> : null}
    <label className="v3-creation-text-field">
      <strong>{t("folders.settings.name")}</strong>
      <Input aria-label={t("folders.settings.name")} placeholder={t("folders.dialog.folderExample")} autoFocus value={value.title}
        onChange={(event) => onChange({ ...value, title: event.target.value })} />
    </label>
    <label className="v3-creation-text-field">
      <strong>{t("folders.settings.description")}</strong>
      <GrowingTextarea label={t("folders.settings.description")} value={value.description} disabled={disabled}
        onChange={(description) => onChange({ ...value, description })} />
    </label>
    <section className="v3-folder-settings-section" data-section="guidance">
      <div className="v3-context-section-head">
        <strong>{t("folders.settings.guidance")}</strong>
        <ContextSourceToggle label={t("folders.settings.guidance")} value={value.guidance.source} disabled={disabled} onChange={setGuidanceSource} />
      </div>
      {value.guidance.source === "own"
        ? <GrowingTextarea label={t("folders.settings.guidance")} value={value.guidance.text} disabled={disabled}
            placeholder={inheritedGuidanceText || t("folders.settings.guidancePlaceholder")}
            onChange={(text) => onChange({ ...value, guidance: { source: "own", text } })} />
        : inheritedGuidance.length > 0
          ? <p className="v3-inherited-value"><ContextSourceMark name={inheritedGuidance.at(-1)!.source.folderName} /><span>{inheritedGuidanceText}</span></p>
          : nothingInherited}
    </section>
    <section className="v3-folder-settings-section" data-section="references">
      <div className="v3-context-section-head">
        <strong>{t("folders.settings.references")}</strong>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={(event) => onEditReference(null, event.currentTarget)}>
          <Plus aria-hidden="true" />{t("folders.settings.add")}
        </Button>
      </div>
      <ReferenceRows inherited={inheritedReferences} own={value.atomReferences} disabled={disabled}
        onEdit={(index, element) => onEditReference(index, element)}
        onRemove={(index) => onChange({ ...value, atomReferences: value.atomReferences.filter((_, i) => i !== index) })} />
    </section>
    <section className="v3-folder-settings-section" data-section="defaults">
      <div className="v3-context-section-head">
        <strong>{t("folders.settings.sessionDefaults")}</strong>
        <ContextSourceToggle label={t("folders.settings.sessionDefaults")} value={defaults.source} disabled={disabled} onChange={setDefaultsSource} />
      </div>
      {defaults.source === "own"
        ? <AgentNodeAssignmentFields data={assignment} disabled={disabled}
            nodeId={defaults.nodeId} agentId={defaults.agentId} modelPreset={defaults.modelPreset}
            onNodeIdChange={(nodeId) => { onModelValidityChange(true); onChange({ ...value, sessionDefaults: { ...defaults, nodeId, modelPreset: "" } }); }}
            onAgentIdChange={(agentId) => onChange({ ...value, sessionDefaults: { ...defaults, agentId } })}
            onModelPresetChange={(modelPreset) => onChange({ ...value, sessionDefaults: { ...defaults, modelPreset } })}
            onModelPresetValidityChange={onModelValidityChange} onError={onError} />
        : inheritedDefaults
          ? <p className="v3-inherited-value"><ContextSourceMark name={inheritedDefaults.source.folderName} /><span>{inheritedDefaultsLabel}</span></p>
          : nothingInherited}
    </section>
  </fieldset>;
}
