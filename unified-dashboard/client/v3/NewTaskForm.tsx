import { useCallback, useMemo, useRef, useState } from "react";
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
import type { InitialTaskContext } from "@seosoyoung/soul-ui/page";
import type { ProjectContextPreviewState } from "./project-context-inheritance";
import {
  ProjectAtomChip,
  ProjectSessionDefaultChip,
} from "./ProjectContextChips";
import { useProjectContextInheritance } from "./use-project-context-inheritance";
import { AgentNodeAssignmentFields } from "./AgentNodeAssignmentFields";
import { InitialTaskContextPicker } from "./TaskContextPicker";
import "./v3-content-boundary.css";
import { writeFailureText } from "./v3-dashboard-utils";

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
  onCreate(
    title: string,
    folderId: string,
    description: string,
    initialContext: InitialTaskContext,
  ): Promise<string | null>;
  onCancel(): void;
}) {
  const folderOptions = useMemo(() => newTaskFolderOptions(folders), [folders]);
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState(
    initialFolderId ?? folderOptions[0]?.folder.id ?? "",
  );
  const [description, setDescription] = useState("");
  const [initialContext, setInitialContext] = useState<InitialTaskContext>({
    guidance: "",
    atomReferences: [],
  });
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [defaultNodeId, setDefaultNodeId] = useState("");
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionInFlight = useRef(false);
  const inheritance = useProjectContextInheritance({
    folderId,
    folders,
    invalidationKey,
  });

  const selected = folders.find((folder) => folder.id === folderId);
  const retainedProjectName = inheritance.status === "ready"
    ? inheritance.data.pages.at(-1)?.source.folderName
    : null;

  const busy = pending || submitting;
  const partialDefaultAssignment = Boolean(defaultAgentId.trim()) !== Boolean(defaultNodeId.trim());
  const updateDefaultNodeId = useCallback((value: string) => {
    setDefaultNodeId(value);
    setDefaultAgentId("");
  }, []);
  const submit = async () => {
    const normalized = title.trim();
    if (!normalized || !folderId || partialDefaultAssignment || busy || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const sessionDefaults = defaultAgentId.trim() && defaultNodeId.trim()
        ? { agentId: defaultAgentId.trim(), nodeId: defaultNodeId.trim() }
        : undefined;
      setError(await onCreate(normalized, folderId, description, {
        ...initialContext,
        ...(sessionDefaults ? { sessionDefaults } : {}),
      }));
    } catch (cause) {
      setError(writeFailureText("새 업무 생성", cause));
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>새 업무</DialogTitle>
          <DialogDescription>프로젝트에 업무 페이지와 업무를 함께 만듭니다.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="v3-new-task-dialog">
            <label>
              <span>프로젝트</span>
              <select
                value={folderId}
                disabled={busy}
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
                disabled={busy}
                placeholder="업무 이름"
                aria-label="새 업무 제목"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void submit(); }
                }}
              />
            </label>
            <label>
              <span>설명 <small>마크다운</small></span>
              <textarea
                value={description}
                disabled={busy}
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
            <section className="v3-new-task-context" data-testid="new-task-default-assignment">
              <div className="v3-new-task-context-head">
                <span>
                  <strong>이 업무의 기본 담당</strong>
                  <small>새 세션을 만들 때 사용할 노드와 에이전트 · 선택 사항</small>
                </span>
              </div>
              <AgentNodeAssignmentFields
                agentId={defaultAgentId}
                nodeId={defaultNodeId}
                presentation="session"
                disabled={busy}
                onAgentIdChange={setDefaultAgentId}
                onNodeIdChange={updateDefaultNodeId}
                onError={setAssignmentError}
              />
              {assignmentError ? <small role="alert">{assignmentError}</small> : null}
              {partialDefaultAssignment ? <small>기본 담당은 노드와 에이전트를 모두 선택해야 합니다.</small> : null}
            </section>
            <InitialTaskContextPicker
              value={initialContext}
              disabled={busy}
              onChange={setInitialContext}
            />
            {error ? <p className="v3-new-task-error" role="alert">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>취소</Button>
          <Button onClick={() => { void submit(); }} disabled={busy || !title.trim() || !folderId || partialDefaultAssignment}>
            {busy ? "만드는 중…" : "업무 만들기"}
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
      <strong>컨텍스트 · {projectName}</strong>
      {state.status === "loading" ? <small>프로젝트 컨텍스트를 불러오는 중…</small> : null}
      {state.status === "error" ? <small role="alert">불러오기 실패 · {state.message}</small> : null}
      {state.status === "ready" ? (
        <>
          <div className="v3-project-context-row" data-testid="inheritance-guidance">
            {state.data.guidance.length > 0 ? state.data.guidance.map((guidance) => (
              <div className="v3-project-guidance" key={guidance.blockId}>
                <span className="v3-text-clamp-3" data-testid="inheritance-guidance-preview">
                  {guidance.text}
                </span>
                <small>{guidance.source.folderName}에서 상속</small>
              </div>
            )) : <small>지침 없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-atom">
            <strong>atom</strong>
            {state.data.atomReferences.length > 0 ? state.data.atomReferences.map((reference) => (
              <span className="v3-project-context-sourced" key={reference.blockId}>
                <ProjectAtomChip reference={reference} />
                <small>{reference.source.folderName}에서 상속</small>
              </span>
            )) : <small>없음</small>}
          </div>
          <div className="v3-project-context-row" data-testid="inheritance-defaults">
            <strong>기본 담당</strong>
            {state.data.sessionDefaults.length > 0 ? state.data.sessionDefaults.map((defaults) => (
              <span className="v3-project-context-sourced" key={defaults.blockId}>
                <ProjectSessionDefaultChip defaults={defaults} />
                <small>{defaults.source.folderName}에서 상속</small>
              </span>
            )) : <small>없음</small>}
          </div>
        </>
      ) : null}
    </section>
  );
}
