import { useEffect, useMemo, useState } from "react";
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
  ProjectSessionDefaultsFields,
} from "./ProjectContextFormFields";
import {
  emptyProjectFormValue,
  projectFormValueFromDetails,
  type ProjectFormValue,
} from "./project-form-model";
import {
  fetchProjectPageDetails,
  type ProjectPageDetails,
} from "./project-page-details";

export type ProjectDialogTarget =
  | { mode: "create"; parentFolderId: string | null; parentName: string | null }
  | { mode: "edit"; folder: CatalogFolder };

const EMPTY_DETAILS: ProjectPageDetails = {
  guidance: [],
  atomReferences: [],
  sessionDefaults: [],
};

export function ProjectDialog({
  target,
  onClose,
  onCreateIdentity,
  onRename,
  onSaveContext,
  onSaved,
}: {
  target: ProjectDialogTarget | null;
  onClose(): void;
  onCreateIdentity(title: string, parentFolderId: string | null): Promise<CatalogFolder>;
  onRename(folder: CatalogFolder, title: string): Promise<void>;
  onSaveContext(pageId: string, previous: ProjectPageDetails, value: ProjectFormValue): Promise<void>;
  onSaved(folder: CatalogFolder): void;
}) {
  const [value, setValue] = useState<ProjectFormValue>(() => emptyProjectFormValue());
  const [previous, setPrevious] = useState<ProjectPageDetails>(EMPTY_DETAILS);
  const [createdFolder, setCreatedFolder] = useState<CatalogFolder | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveFolder = target?.mode === "edit" ? target.folder : createdFolder;

  useEffect(() => {
    setCreatedFolder(null);
    setError(null);
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
    void fetchProjectPageDetails(pageId).then((snapshot) => {
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

  const title = target?.mode === "create" && !createdFolder ? "새 프로젝트" : "프로젝트 설정";
  const description = target?.mode === "create" && target.parentName
    ? `${target.parentName} 아래에 만듭니다.`
    : "이름과 프로젝트 컨텍스트를 한곳에서 관리합니다.";
  const canSubmit = !loadFailed && value.title.trim().length > 0
    && value.guidance.every((item) => item.text.trim().length > 0)
    && value.atomReferences.every((item) => item.nodeId.trim().length > 0 && item.depth >= 1 && item.depth <= 5);

  const submit = async () => {
    if (!target || pending || !canSubmit) return;
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
      await onSaveContext(folder.projectPageId ?? folder.id, previous, value);
      onSaved(folder);
      onClose();
    } catch (cause) {
      setError(`프로젝트 저장 실패 · ${errorText(cause)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loading ? <p aria-busy="true">프로젝트 설정을 불러오는 중…</p> : loadFailed ? null : (
            <ProjectFormFields value={value} disabled={pending} onChange={setValue} onError={setError} />
          )}
          {error ? <p className="v3-project-star-error" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>취소</Button>
          <Button type="button" disabled={loading || pending || !canSubmit} onClick={() => { void submit(); }}>
            {pending ? "저장 중…" : target?.mode === "create" && !createdFolder ? "만들기" : "저장"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectFormFields({
  value,
  disabled,
  onChange,
  onError,
}: {
  value: ProjectFormValue;
  disabled: boolean;
  onChange(value: ProjectFormValue): void;
  onError(message: string | null): void;
}) {
  const emptyAtom = useMemo(() => ({
    blockId: null,
    instance: "atom" as const,
    nodeId: "",
    nodeTitle: "",
    depth: 3,
    titlesOnly: false,
  }), []);
  return (
    <div className="v3-project-dialog-form" data-testid="v3-project-dialog-form">
      <label>
        <span>프로젝트 이름</span>
        <input autoFocus value={value.title} disabled={disabled} onChange={(event) => onChange({ ...value, title: event.target.value })} />
      </label>
      <fieldset>
        <legend>guidance</legend>
        {value.guidance.map((item, index) => (
          <div className="v3-project-dialog-entry" key={item.blockId ?? `new-guidance-${index}`}>
            <textarea rows={4} value={item.text} disabled={disabled} onChange={(event) => onChange({
              ...value,
              guidance: value.guidance.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, text: event.target.value } : candidate),
            })} />
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, guidance: value.guidance.filter((_, itemIndex) => itemIndex !== index) })}>제거</Button>
          </div>
        ))}
        <Button type="button" variant="outline" disabled={disabled} onClick={() => onChange({ ...value, guidance: [...value.guidance, { blockId: null, text: "" }] })}>＋ guidance</Button>
      </fieldset>
      <fieldset>
        <legend>atom</legend>
        {value.atomReferences.map((item, index) => (
          <div className="v3-project-dialog-entry" key={item.blockId ?? `new-atom-${index}`}>
            <ProjectAtomFields value={item} disabled={disabled} onChange={(next) => onChange({
              ...value,
              atomReferences: value.atomReferences.map((candidate, itemIndex) => itemIndex === index ? { ...candidate, ...next } : candidate),
            })} />
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, atomReferences: value.atomReferences.filter((_, itemIndex) => itemIndex !== index) })}>제거</Button>
          </div>
        ))}
        <Button type="button" variant="outline" disabled={disabled} onClick={() => onChange({ ...value, atomReferences: [...value.atomReferences, emptyAtom] })}>＋ atom</Button>
      </fieldset>
      <fieldset>
        <legend>기본 에이전트</legend>
        {value.sessionDefaults ? (
          <div className="v3-project-dialog-entry">
            <ProjectSessionDefaultsFields
              agentId={value.sessionDefaults.agentId}
              nodeId={value.sessionDefaults.nodeId}
              disabled={disabled}
              onAgentIdChange={(agentId) => onChange({ ...value, sessionDefaults: value.sessionDefaults ? { ...value.sessionDefaults, agentId } : null })}
              onNodeIdChange={(nodeId) => onChange({ ...value, sessionDefaults: value.sessionDefaults ? { ...value.sessionDefaults, nodeId } : null })}
              onError={(message) => onError(message)}
            />
            <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange({ ...value, sessionDefaults: null })}>제거</Button>
          </div>
        ) : (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => onChange({ ...value, sessionDefaults: { blockId: null, agentId: "", nodeId: "" } })}>＋ 기본 에이전트</Button>
        )}
      </fieldset>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
