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
  createLabel = "새 폴더",
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
  const [assignmentValid, setAssignmentValid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const effectiveFolder = target?.mode === "edit" ? target.folder : createdFolder;

  useEffect(() => {
    attempt.current = {};
    busy.current = false;
    setEditor(null);
    setCreatedFolder(null);
    setError(null);
    setLoadFailed(false);
    setAssignmentValid(true);
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
        setError(`프로젝트 설정을 불러오지 못했습니다 · ${errorText(cause)}`);
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [target]);

  const title = target?.mode === "create" && !createdFolder ? createLabel : "폴더 설정";
  const description = target?.mode === "create" && target.parentName
    ? `${target.parentName} 아래에 만듭니다.`
    : target?.mode === "create" ? "폴더를 먼저 만들고, 작업에 필요한 컨텍스트를 더하세요." : "폴더의 이름과 작업 컨텍스트를 관리합니다.";
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
      setError(`프로젝트 저장 실패 · ${errorText(cause)}`);
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
          <DialogTitle>{editor ? editor.kind === "atom" ? "참고 자료" : "기본 실행 환경" : title}</DialogTitle>
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
          {loading ? <p aria-busy="true">프로젝트 설정을 불러오는 중…</p> : loadFailed ? null : (
            <ProjectFormFields key={target?.mode === "edit" ? target.folder.id : "create"}
              value={value} disabled={pending} onChange={setValue} onEdit={openEditor} />
          )}
          </div>
          {error ? <p className="v3-project-star-error" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          {editor ? <>
            <Button variant="outline" onClick={closeEditor}>취소</Button>
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
                  setAssignmentValid(true);
                }
                closeEditor();
              }}>{editor.kind === "atom" && editor.index === null ? "자료 추가" : "확인"}</Button>
          </> : <>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>취소</Button>
          <Button type="button" disabled={loading || pending || !canSubmit} onClick={() => { void submit(); }}>
            {pending ? "저장 중…" : target?.mode === "create" && !createdFolder ? "만들기" : "저장"}
          </Button>
          </>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectFormFields({ value, disabled, onChange, onEdit }: {
  value: ProjectFormValue; disabled: boolean; onChange(value: ProjectFormValue): void;
  onEdit(editor: Editor, trigger: HTMLElement): void;
}) {
  const guidanceInputs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const focusGuidance = useRef<number | null>(null);
  useEffect(() => {
    if (focusGuidance.current === null) return;
    const input = guidanceInputs.current[focusGuidance.current];
    input?.focus(); input?.scrollIntoView?.({ block: "nearest" }); focusGuidance.current = null;
  }, [value.guidance]);
  return <div className="v3-project-dialog-form" data-testid="v3-project-dialog-form">
    <label><span>폴더 이름 <small className="project-required">필수</small></span>
      <input aria-label="폴더 이름" placeholder="예: 대시보드 개선" autoFocus value={value.title} disabled={disabled}
        onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <div className="project-optional-heading"><strong>작업 컨텍스트</strong><span>선택 · 나중에 추가할 수 있어요</span></div>
    <CreationDisclosure className="project-context-disclosure" title="작업 지침" summary="에이전트가 참고할 목표와 규칙" defaultExpanded={value.guidance.length > 0}>
      <fieldset><legend className="sr-only">작업 지침</legend>
        {value.guidance.map((item, index) => <div className="v3-project-dialog-entry" key={item.blockId ?? item.draftId ?? index}>
          <textarea rows={4} aria-label={`작업 지침 ${index + 1}`} ref={element => { guidanceInputs.current[index] = element; }} value={item.text} disabled={disabled}
            onChange={event => onChange({ ...value, guidance: value.guidance.map((candidate, i) => i === index ? { ...candidate, text: event.target.value } : candidate) })} />
          {!item.text.trim() ? <small>지침을 입력하거나 빈 항목을 제거하세요</small> : null}
          <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, guidance: value.guidance.filter((_, i) => i !== index) })}>제거</Button>
        </div>)}
        <Button variant="outline" disabled={disabled} onClick={() => {
          const empty = value.guidance.findIndex(item => !item.text.trim());
          if (empty >= 0) { guidanceInputs.current[empty]?.focus(); guidanceInputs.current[empty]?.scrollIntoView?.({ block: "nearest" }); return; }
          focusGuidance.current = value.guidance.length;
          onChange({ ...value, guidance: [...value.guidance, { blockId: null, draftId: crypto.randomUUID(), text: "" }] });
        }}>지침 추가</Button>
      </fieldset>
    </CreationDisclosure>
    <CreationDisclosure className="project-context-disclosure" title="참고 자료" summary="atom에서 가져올 지식과 문서" defaultExpanded={value.atomReferences.length > 0}>
      <fieldset><legend className="sr-only">참고 자료</legend>
        {value.atomReferences.map((item, index) => <div className="v3-project-dialog-entry" key={item.blockId ?? item.draftId ?? index}>
          <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "atom", value: { ...item }, index }, event.currentTarget)}>{item.nodeTitle} · {item.instance}</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, atomReferences: value.atomReferences.filter((_, i) => i !== index) })}>제거</Button>
        </div>)}
        <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "atom", index: null,
          value: { blockId: null, instance: "atom", nodeId: "", nodeTitle: "", depth: 3, titlesOnly: false, limit: null } }, event.currentTarget)}>atom에서 추가</Button>
      </fieldset>
    </CreationDisclosure>
    <CreationDisclosure className="project-context-disclosure" title="기본 실행 환경" summary="이 폴더에서 사용할 에이전트와 모델" defaultExpanded={value.sessionDefaults !== null}>
      <fieldset><legend className="sr-only">기본 에이전트</legend>
        {value.sessionDefaults ? <p>{value.sessionDefaults.agentId || "에이전트 상속"} / {value.sessionDefaults.nodeId || "노드 상속"} / {value.sessionDefaults.modelPreset || "모델 상속"}</p> : null}
        <Button variant="outline" disabled={disabled} onClick={event => onEdit({ kind: "defaults", value: value.sessionDefaults ? { ...value.sessionDefaults } : { blockId: null, agentId: "", nodeId: "", modelPreset: "" } }, event.currentTarget)}>{value.sessionDefaults ? "기본 실행 환경 편집" : "＋ 기본 에이전트"}</Button>
        {value.sessionDefaults ? <Button variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, sessionDefaults: null })}>제거</Button> : null}
      </fieldset>
    </CreationDisclosure>
  </div>;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
