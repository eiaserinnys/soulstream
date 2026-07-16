import { useMemo, useState } from "react";
import {
  buildFolderTreeOptions,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@seosoyoung/soul-ui";
import type { CatalogFolder, FolderTreeOption } from "@seosoyoung/soul-ui";
import type { ProjectContextPreviewState } from "./project-context-inheritance";
import {
  ProjectAtomChip,
  ProjectSessionDefaultChip,
} from "./ProjectContextChips";
import { useProjectContextInheritance } from "./use-project-context-inheritance";

export function NewTaskForm({
  folders,
  invalidationKey = 0,
  initialFolderId,
  pending,
  onCreate,
  onCancel,
}: {
  folders: readonly CatalogFolder[];
  invalidationKey?: number;
  initialFolderId: string | null;
  pending: boolean;
  onCreate(title: string, folderId: string, description: string): void;
  onCancel(): void;
}) {
  const folderOptions = useMemo(() => newTaskFolderOptions(folders), [folders]);
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState(
    initialFolderId ?? folderOptions[0]?.folder.id ?? "",
  );
  const [description, setDescription] = useState("");
  const inheritance = useProjectContextInheritance({
    folderId,
    folders,
    invalidationKey,
  });

  const selected = folders.find((folder) => folder.id === folderId);
  const retainedProjectName = inheritance.status === "ready"
    ? inheritance.data.pages.at(-1)?.source.folderName
    : null;

  const submit = () => {
    const normalized = title.trim();
    if (!normalized || !folderId || pending) return;
    onCreate(normalized, folderId, description);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>새 업무</DialogTitle>
          <DialogDescription>프로젝트에 업무 페이지와 런북을 함께 만듭니다.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="v3-new-task-dialog">
            <label>
              <span>프로젝트</span>
              <select
                value={folderId}
                disabled={pending}
                aria-label="프로젝트 선택"
                onChange={(event) => setFolderId(event.target.value)}
              >
                {folderOptions.map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${"　".repeat(depth)}${folder.name}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>업무 이름</span>
              <input
                autoFocus
                value={title}
                disabled={pending}
                placeholder="업무 이름"
                aria-label="새 업무 제목"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); submit(); }
                }}
              />
            </label>
            <label>
              <span>설명 <small>마크다운</small></span>
              <textarea
                value={description}
                disabled={pending}
                placeholder="목표와 완료 조건을 적어두세요."
                aria-label="업무 설명"
                rows={7}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <ProjectInheritancePreview
              projectName={selected?.name ?? retainedProjectName ?? "프로젝트"}
              state={inheritance}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>취소</Button>
          <Button onClick={submit} disabled={pending || !title.trim() || !folderId}>
            {pending ? "만드는 중…" : "업무 만들기"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function newTaskFolderOptions(
  folders: readonly CatalogFolder[],
): FolderTreeOption[] {
  return buildFolderTreeOptions(folders);
}

export function ProjectInheritancePreview({
  projectName,
  state,
}: {
  projectName: string;
  state: ProjectContextPreviewState;
}) {
  return (
    <section
      className="v3-project-context"
      data-testid="new-task-inheritance-preview"
      aria-live="polite"
    >
      <strong>컨텍스트 미리보기 · {projectName}</strong>
      {state.status === "loading" ? <small>프로젝트 컨텍스트를 불러오는 중…</small> : null}
      {state.status === "error" ? <small role="alert">불러오기 실패 · {state.message}</small> : null}
      {state.status === "ready" ? (
        <>
          <div className="v3-project-context-row" data-testid="inheritance-guidance">
            {state.data.guidance.length > 0 ? state.data.guidance.map((guidance) => (
              <div className="v3-project-guidance" key={guidance.blockId}>
                <span className="line-clamp-3" data-testid="inheritance-guidance-preview">
                  {guidance.text}
                </span>
                <small>{guidance.source.folderName}에서 상속</small>
              </div>
            )) : <small>지침 없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-atom">
            <strong>지식</strong>
            {state.data.atomReferences.length > 0 ? state.data.atomReferences.map((reference) => (
              <span className="v3-project-context-sourced" key={reference.blockId}>
                <ProjectAtomChip reference={reference} />
                <small>{reference.source.folderName}에서 상속</small>
              </span>
            )) : <small>지식 없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-defaults">
            <strong>실행 기본값</strong>
            {state.data.sessionDefaults.length > 0 ? state.data.sessionDefaults.map((defaults) => (
              <span className="v3-project-context-sourced" key={defaults.blockId}>
                <ProjectSessionDefaultChip defaults={defaults} />
                <small>{defaults.source.folderName}에서 상속</small>
              </span>
            )) : <small>기본값 없음</small>}
          </div>
        </>
      ) : null}
    </section>
  );
}
