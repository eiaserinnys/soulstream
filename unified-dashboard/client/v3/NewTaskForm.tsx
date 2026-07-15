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
} from "@seosoyoung/soul-ui";
import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "@seosoyoung/soul-ui/page";

import {
  fetchProjectPageDetails,
  type ProjectPageDetails,
} from "./project-page-details";
import { resolveProjectFolderId } from "./planner-model";
import {
  ProjectAtomChip,
  ProjectSessionDefaultChip,
} from "./ProjectContextChips";
import { singleLinePreview } from "./session-preview";

const GUIDANCE_PREVIEW_LENGTH = 240;
const EMPTY_PROJECT_CONTEXT: ProjectPageDetails = {
  guidance: [],
  atomReferences: [],
  sessionDefaults: [],
};

type ProjectInheritancePreviewState =
  | { status: "loading"; data: null; message: null }
  | { status: "ready"; data: ProjectPageDetails; message: null }
  | { status: "error"; data: null; message: string };

export function NewTaskForm({
  folders,
  projectPages,
  initialFolderId,
  pending,
  onCreate,
  onCancel,
}: {
  folders: readonly CatalogFolder[];
  projectPages: readonly PageDto[];
  initialFolderId: string | null;
  pending: boolean;
  onCreate(title: string, folderId: string, description: string): void;
  onCancel(): void;
}) {
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState(initialFolderId ?? folders[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const selectedProjectPage = useMemo(
    () => findProjectPageForFolder(folderId, folders, projectPages),
    [folderId, folders, projectPages],
  );
  const [inheritance, setInheritance] = useState<ProjectInheritancePreviewState>({
    status: "loading",
    data: null,
    message: null,
  });

  const selected = folders.find((folder) => folder.id === folderId);
  useEffect(() => {
    if (!selectedProjectPage) {
      setInheritance({ status: "ready", data: EMPTY_PROJECT_CONTEXT, message: null });
      return;
    }
    let active = true;
    setInheritance({ status: "loading", data: null, message: null });
    void fetchProjectPageDetails(selectedProjectPage.id).then((snapshot) => {
      if (!active) return;
      setInheritance({
        status: "ready",
        data: {
          guidance: snapshot.guidance,
          atomReferences: snapshot.atomReferences,
          sessionDefaults: snapshot.sessionDefaults,
        },
        message: null,
      });
    }).catch((error: unknown) => {
      if (!active) return;
      setInheritance({
        status: "error",
        data: null,
        message: error instanceof Error && error.message ? error.message : String(error),
      });
    });
    return () => { active = false; };
  }, [selectedProjectPage?.id]);

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
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
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
              projectName={selected?.name ?? "프로젝트"}
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

export function findProjectPageForFolder(
  folderId: string,
  folders: readonly CatalogFolder[],
  projectPages: readonly PageDto[],
): PageDto | null {
  return projectPages.find((page) => resolveProjectFolderId(page, folders) === folderId) ?? null;
}

export function ProjectInheritancePreview({
  projectName,
  state,
}: {
  projectName: string;
  state: ProjectInheritancePreviewState;
}) {
  return (
    <section
      className="v3-project-context"
      data-testid="new-task-inheritance-preview"
      aria-live="polite"
    >
      <strong>상속 미리보기 · {projectName}</strong>
      {state.status === "loading" ? <small>프로젝트 컨텍스트를 불러오는 중…</small> : null}
      {state.status === "error" ? <small role="alert">불러오기 실패 · {state.message}</small> : null}
      {state.status === "ready" ? (
        <>
          <div className="v3-project-context-row" data-testid="inheritance-guidance">
            <strong>guidance</strong>
            {state.data.guidance.length > 0 ? state.data.guidance.map((guidance) => (
              <details className="v3-project-guidance" key={guidance.blockId}>
                <summary aria-label="guidance 프리뷰 펼치기">
                  <span className="line-clamp-3" data-testid="inheritance-guidance-preview">
                    {singleLinePreview(guidance.text, GUIDANCE_PREVIEW_LENGTH)}
                  </span>
                </summary>
                <pre data-testid="inheritance-guidance-full">{guidance.text}</pre>
              </details>
            )) : <small>없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-atom">
            <strong>atom</strong>
            {state.data.atomReferences.length > 0 ? state.data.atomReferences.map((reference) => (
              <ProjectAtomChip key={reference.blockId} reference={reference} />
            )) : <small>없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-defaults">
            <strong>실행 기본값</strong>
            {state.data.sessionDefaults.length > 0 ? state.data.sessionDefaults.map((defaults) => (
              <ProjectSessionDefaultChip key={defaults.blockId} defaults={defaults} />
            )) : <small>없음</small>}
          </div>
        </>
      ) : null}
    </section>
  );
}
