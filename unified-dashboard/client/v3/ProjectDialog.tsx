import { folderErrorText } from "./folder-messages";
import { dictionaries } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  FrameLoading,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";

import {
  ProjectAtomFields,
  isProjectAtomValid,
  ProjectSessionDefaultsFields,
} from "./ProjectContextFormFields";
import {
  emptyProjectFormValue,
  projectFormValueFromDetails,
  type ProjectFormValue,
  type ProjectFormAtomReference,
  type ProjectFormSessionDefaults,
} from "./project-form-model";
import {
  fetchProjectPageDetails,
  type ProjectPageDetails,
} from "./project-page-details";

import { modelPresetSelectionState } from "../lib/model-presets";
import { useNodeModelPresetCatalog } from "../lib/use-node-model-preset-catalog";
import { CreationDisclosure } from "./CreationDisclosure";
import type { ProjectContextSaveSession } from "./project-form-actions";

type Editor = { kind: "atom"; value: ProjectFormAtomReference; index: number | null } | { kind: "defaults"; value: ProjectFormSessionDefaults };

export type ProjectDialogTarget =
  | { mode: "create"; parentFolderId: string | null; parentName: string | null }
  | { mode: "edit"; folder: CatalogFolder };

const EMPTY_DETAILS: ProjectPageDetails = {
  guidance: [],
  atomReferences: [],
  sessionDefaults: [],
};

export function ProjectDialog({
  request, assignment,
  target,
  createLabel,
  onClose,
  onCreateIdentity,
  onRename,
  onSaveContext,
  onSaved,
}: {
  request?: typeof fetch;
  assignment?: import("./AgentNodeAssignmentFields").AssignmentData;
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeStatus, setTreeStatus] = useState<"loading" | "ready" | "error">("ready");
  const [editorValid, setEditorValid] = useState(true);
  const closeEditor = () => { setEditor(null); queueMicrotask(() => trigger.current?.focus()); };
  const openEditor = (next: Editor, element: HTMLElement) => {
    trigger.current = element; setEditorValid(true); setTreeStatus("ready");
    setTreeOpen(next.kind === "atom" && next.value.instance === "atom"); setEditor(next);
  };
  const [value, setValue] = useState<ProjectFormValue>(() => emptyProjectFormValue());
  const [previous, setPrevious] = useState<ProjectPageDetails>(EMPTY_DETAILS);
  const [createdFolder, setCreatedFolder] = useState<CatalogFolder | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<{ key: string; cause: unknown } | null>(null);
  const defaultsNode = value.sessionDefaults?.nodeId ?? "";
  const suppliedCatalog = assignment?.modelPresetCatalog.nodeId === defaultsNode ? assignment.modelPresetCatalog : null;
  const internalCatalog = useNodeModelPresetCatalog(suppliedCatalog ? "" : defaultsNode, setError);
  const catalog = suppliedCatalog ?? internalCatalog;
  const assignmentValid = modelPresetSelectionState(value.sessionDefaults?.modelPreset ?? "", catalog.presets,
    catalog.nodeId === defaultsNode && catalog.status === "ready").valid;
  const effectiveFolder = target?.mode === "edit" ? target.folder : createdFolder;

  useEffect(() => {
    attempt.current = {};
    busy.current = false;
    setEditor(null);
    setCreatedFolder(null);
    setError(null);
    setDialogError(null);
    setLoadFailed(false);
    if (!target) return;
    if (target.mode === "create") {
      setPrevious(EMPTY_DETAILS);
      setValue(emptyProjectFormValue());
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const pageId = target.folder.projectPageId ?? target.folder.id;
    void fetchProjectPageDetails(pageId, request).then((snapshot) => {
      if (!active) return;
      setPrevious(snapshot);
      setValue(projectFormValueFromDetails(target.folder.name, snapshot));
    }).catch((cause: unknown) => {
      if (active) {
        setLoadFailed(true);
        setDialogError({ key: "folders.dialog.loadError", cause });
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, target]);

  const visibleError = dialogError
    ? t(dialogError.key, { detail: folderErrorText(t, dialogError.cause) }) : error;
  const newFolderLabel = createLabel && createLabel !== dictionaries.ko.folders.common.newFolder
    ? createLabel : t("folders.common.newFolder");
  const title = target?.mode === "create" && !createdFolder ? newFolderLabel : t("folders.dialog.title");
  const description = target?.mode === "create" && target.parentName
    ? t("folders.dialog.createUnder", { name: target.parentName })
    : target?.mode === "create" ? t("folders.dialog.createHint") : t("folders.dialog.settingsHint");
  const canSubmit = !loadFailed && value.title.trim().length > 0
    && assignmentValid
    && value.guidance.every((item) => item.text.trim().length > 0)
    && value.atomReferences.every((item) => (
      item.nodeId.trim().length > 0
      && item.depth >= 1
      && item.depth <= 5
      && (item.limit == null || (Number.isInteger(item.limit) && item.limit > 0))
    ));

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
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !busy.current) { if (editor) closeEditor(); else onClose(); } }}>
      <DialogPopup className="max-w-xl project-purpose-dialog" closeProps={{ disabled: pending }}
        onKeyDown={(event) => { if (event.key === "Escape" && editor) { event.preventDefault(); event.stopPropagation(); if (!treeOpen) closeEditor(); else setTreeOpen(false); } }}>
        <DialogHeader>
          <DialogTitle>{editor ? editor.kind === "atom" ? t("folders.dialog.references") : t("folders.dialog.sessionDefaults") : title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {editor ? editor.kind === "atom" ? (
            <ProjectAtomFields request={request} value={editor.value} disabled={pending}
              selectorOpen={treeOpen} onSelectorOpenChange={setTreeOpen} onSelectorStatusChange={setTreeStatus}
              onChange={(next) => setEditor({ ...editor, value: { ...editor.value, ...next } })} />
          ) : (
            <ProjectSessionDefaultsFields assignment={assignment} {...editor.value} disabled={pending}
              onAgentIdChange={(agentId) => setEditor({ ...editor, value: { ...editor.value, agentId } })}
              onNodeIdChange={(nodeId) => { setEditorValid(true); setEditor({ ...editor, value: { ...editor.value, nodeId, modelPreset: "" } }); }}
              onModelPresetChange={(modelPreset) => setEditor({ ...editor, value: { ...editor.value, modelPreset } })}
              onModelPresetValidityChange={setEditorValid} onError={setError} />
          ) : null}
          <div hidden={editor !== null}>
          {loading ? <FrameLoading label={t("folders.dialog.loading")} /> : loadFailed ? null : (
            <ProjectFormFields key={target?.mode === "edit" ? target.folder.id : "create"}
              value={value} disabled={pending} defaultsInvalid={!assignmentValid} onChange={setValue} onEdit={openEditor} />
          )}
          </div>
          {visibleError ? <p className="v3-project-star-error" role="alert" data-v3-selectable-content="true">{visibleError}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          {editor ? <>
            <Button variant="outline" onClick={closeEditor}>{t("folders.common.cancel")}</Button>
            <Button disabled={editor.kind === "atom" ? treeOpen || treeStatus !== "ready" || !isProjectAtomValid(editor.value) : !editorValid}
              onClick={() => {
                if (editor.kind === "atom") {
                  const duplicate = value.atomReferences.findIndex(item => item.instance === editor.value.instance && item.nodeId === editor.value.nodeId);
                  const index = duplicate >= 0 ? duplicate : editor.index;
                  const item = { ...editor.value, blockId: index === null ? null : value.atomReferences[index].blockId,
                    draftId: index === null ? crypto.randomUUID() : value.atomReferences[index].draftId };
                  const atomReferences = value.atomReferences.filter((_, i) => i !== editor.index || editor.index === index);
                  if (index === null) atomReferences.push(item);
                  else atomReferences[atomReferences.findIndex(candidate => candidate === value.atomReferences[index])] = item;
                  setValue({ ...value, atomReferences });
                } else {
                  const item = editor.value;
                  setValue({ ...value, sessionDefaults: item.agentId || item.nodeId || item.modelPreset ? item : null });
                              }
                closeEditor();
              }}>{editor.kind === "atom" && editor.index === null ? t("folders.dialog.addReference") : t("folders.common.confirm")}</Button>
          </> : <>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t("folders.common.cancel")}</Button>
          <Button type="button" disabled={loading || pending || !canSubmit} onClick={() => { void submit(); }}>
            {pending ? t("folders.common.saving") : target?.mode === "create" && !createdFolder ? t("folders.common.create") : t("folders.common.save")}
          </Button>
          </>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectFormFields({ value, disabled, defaultsInvalid, onChange, onEdit }: {
  value: ProjectFormValue; disabled: boolean; defaultsInvalid: boolean; onChange(value: ProjectFormValue): void;
  onEdit(editor: Editor, trigger: HTMLElement): void;
}) {
  const { t } = useTranslation();
  const guidanceInputs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const focusGuidance = useRef<number | null>(null);
  useEffect(() => {
    if (focusGuidance.current === null) return;
    const input = guidanceInputs.current[focusGuidance.current];
    input?.focus(); input?.scrollIntoView?.({ block: "nearest" }); focusGuidance.current = null;
  }, [value.guidance]);
  return <div className="v3-project-dialog-form" data-testid="v3-project-dialog-form">
    <label><span>{t("folders.dialog.folderName")} <small className="project-required">{t("folders.dialog.required")}</small></span>
      <input aria-label={t("folders.dialog.folderName")} placeholder={t("folders.dialog.folderExample")} autoFocus value={value.title} disabled={disabled}
        onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <div className="project-optional-heading"><strong>{t("folders.dialog.workContext")}</strong><span>{t("folders.dialog.optional")}</span></div>
    <CreationDisclosure className="project-context-disclosure" title={t("folders.dialog.instructions")} summary={t("folders.dialog.instructionsHint")} defaultExpanded={value.guidance.length > 0}>
      <fieldset><legend className="sr-only">{t("folders.dialog.instructions")}</legend>
        {value.guidance.map((item, index) => <div className="v3-project-dialog-entry" key={item.blockId ?? item.draftId ?? index}>
          <textarea rows={4} aria-label={t("folders.dialog.instructionNumber", { number: index + 1 })} ref={element => { guidanceInputs.current[index] = element; }} value={item.text} disabled={disabled}
            onChange={event => onChange({ ...value, guidance: value.guidance.map((candidate, i) => i === index ? { ...candidate, text: event.target.value } : candidate) })} />
          {!item.text.trim() ? <small>{t("folders.dialog.instructionRequired")}</small> : null}
          <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, guidance: value.guidance.filter((_, i) => i !== index) })}>{t("folders.common.remove")}</Button>
        </div>)}
        <Button variant="outline" disabled={disabled} onClick={() => {
          const empty = value.guidance.findIndex(item => !item.text.trim());
          if (empty >= 0) { guidanceInputs.current[empty]?.focus(); guidanceInputs.current[empty]?.scrollIntoView?.({ block: "nearest" }); return; }
          focusGuidance.current = value.guidance.length;
          onChange({ ...value, guidance: [...value.guidance, { blockId: null, draftId: crypto.randomUUID(), text: "" }] });
        }}>{t("folders.dialog.addInstructions")}</Button>
      </fieldset>
    </CreationDisclosure>
    <CreationDisclosure className="project-context-disclosure" title={t("folders.dialog.references")} summary={t("folders.dialog.referencesHint")} defaultExpanded={value.atomReferences.length > 0}>
      <fieldset><legend className="sr-only">{t("folders.dialog.references")}</legend>
        {value.atomReferences.map((item, index) => <div className="v3-project-dialog-entry" key={item.blockId ?? item.draftId ?? index}>
          <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "atom", value: { ...item }, index }, event.currentTarget)}>{item.nodeTitle} / {item.instance}</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, atomReferences: value.atomReferences.filter((_, i) => i !== index) })}>{t("folders.common.remove")}</Button>
        </div>)}
        <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "atom", index: null,
          value: { blockId: null, instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false, limit: null } }, event.currentTarget)}>{t("folders.dialog.addFromAtom")}</Button>
      </fieldset>
    </CreationDisclosure>
    <CreationDisclosure className="project-context-disclosure" title={t("folders.dialog.sessionDefaults")} invalid={defaultsInvalid} summary={t("folders.dialog.sessionDefaultsHint")} defaultExpanded={value.sessionDefaults !== null}>
      <fieldset><legend className="sr-only">{t("folders.dialog.defaultAgent")}</legend>
        {value.sessionDefaults ? <p>{value.sessionDefaults.agentId || t("folders.dialog.inheritAgent")} / {value.sessionDefaults.nodeId || t("folders.dialog.inheritNode")} / {value.sessionDefaults.modelPreset || t("folders.dialog.inheritModel")}</p> : null}
        <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "defaults", value: value.sessionDefaults ? { ...value.sessionDefaults } : { blockId: null, agentId: "", nodeId: "", modelPreset: "" } }, event.currentTarget)}>{value.sessionDefaults ? t("folders.dialog.editSessionDefaults") : t("folders.dialog.addDefaultAgent")}</Button>
        {value.sessionDefaults ? <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, sessionDefaults: null })}>{t("folders.common.remove")}</Button> : null}
      </fieldset>
    </CreationDisclosure>
  </div>;
}
