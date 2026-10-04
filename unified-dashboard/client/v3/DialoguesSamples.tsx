import {ConnectionDialog} from "../connection/ConnectionDialog";
import { RenameSessionDialog } from "@seosoyoung/soul-ui/components/RenameSessionDialog";
import { useMemo, useState } from "react";
import {
  FolderDialog,
  FolderSettingsDialog,
  MarkdownDeleteDialog,
  SessionMenuOwnerProvider,
} from "@seosoyoung/soul-ui";
import { SessionDeleteDialog, SessionContinueErrorDialog } from "@seosoyoung/soul-ui/components/SessionDialogViews";
import { BoardRenameDialog, BoardMoveDialog } from "@seosoyoung/soul-ui/board-workspace/BoardWorkspaceDialogViews";
import { createPageApiClient } from "@seosoyoung/soul-ui/page";
import { useLocalDialogueUpload } from "./use-local-dialogue-upload";
import { ConfigModal } from "../components/ConfigModal";
import { SearchModal } from "../components/SearchModal";
import {saveProjectFormContext} from "./project-form-actions";
import { ProjectDialog } from "./ProjectDialog";
import { FolderArchiveDialog } from "./FolderArchiveDialog";
import { FolderDetailArchiveDialog } from "./FolderDetailArchiveDialog";
import { FolderParentMoveDialog } from "./FolderParentMoveDialog";
import { FolderMoveDialog } from "./FolderMoveDialog";
import { CardCreateDialog } from "./CardCreateDialog";
import { SessionSuccessionModal } from "./SessionSuccessionModal";
import { RitualModal } from "./RitualModal";
import { dialoguesFolders, dialoguesAssignment, createDialoguesApi } from "./dialogues-api";
import { reviewCard, reviewDetail, reviewFolder, reviewSession } from "./components-review-fixtures";
import type { DialogueId } from "./dialogues-inventory";
import { DialoguesOverlaySamples } from "./DialoguesOverlaySamples";
/** Every branch renders the production component/view, with local operations at its boundary. */
export function DialoguesSamples({
  id,
  api,
  onClose,
  onChanged,
}: {
  id: DialogueId;
  api: ReturnType<typeof createDialoguesApi>;
  onClose(): void;
  onChanged(): void;
}) {
  const [input, setInput] = useState(api.local.sessionName),
    [selected, setSelected] = useState("");
  const upload = useLocalDialogueUpload();
  const pageApi = useMemo(() => createPageApiClient({ fetch: api.request }), [api]);
  const done = (name: string) => {
    api.record(name);
    onChanged();
    onClose();
  };
  const folder = api.local.folder;
  const openChange = (open: boolean) => {
    if (!open) onClose();
  };
  const stars: readonly string[] = [];
  if (id.startsWith("connection-")) return <ConnectionDialog snapshot={{phase: id.slice("connection-".length) as "planned" | "disconnected" | "checking" | "recovering" | "new-version", fresh: false}}/>;
  if (id === "project-create" || id === "project-edit")
    return (
      <ProjectDialog
        target={
          id === "project-create"
            ? { mode: "create", parentFolderId: null, parentName: null }
            : { mode: "edit", folder }
        }
        request={api.request}
        assignment={dialoguesAssignment}
        onClose={onClose}
        onCreateIdentity={async (title) => {
          api.local.folder = { ...folder, name: title };
          return api.local.folder;
        }}
        onRename={async (_, title) => {
          api.local.folder.name = title;
          api.record("폴더 이름 변경");
        }}
        onSaveContext={(id,previous,value,attempt) => saveProjectFormContext(pageApi,id,previous,value,attempt)}
        onSaved={() => done("폴더 저장")}
      />
    );
  if (id === "folder-create")
    return (
      <FolderDialog
        mode="create"
        open
        onOpenChange={openChange}
        onConfirm={(name) => {
          api.local.folder.name = name;
          done(`폴더 생성 · ${name}`);
        }}
      />
    );
  if (id === "archive-board")
    return (
      <FolderDialog
        mode="archive"
        open
        folderName={folder.name}
        onOpenChange={openChange}
        onConfirm={() => done("보드 폴더 보관")}
      />
    );
  if (id === "archive-nav")
    return <FolderArchiveDialog folder={folder} onClose={onClose} onArchive={() => done("폴더 보관")} />;
  if (id === "archive-detail")
    return (
      <FolderDetailArchiveDialog
        open
        title={folder.name}
        error={null}
        onOpenChange={openChange}
        onArchive={() => done("상세 폴더 보관")}
      />
    );
  if (id === "folder-settings")
    return (
      <FolderSettingsDialog
        folder={folder}
        folders={dialoguesFolders}
        open
        onOpenChange={openChange}
        onConfirm={() => done("폴더 설정 저장")}
      />
    );
  if (id === "parent-move")
    return (
      <FolderParentMoveDialog
        task={reviewFolder(folder.name, folder.id)}
        folders={dialoguesFolders}
        currentFolderId={null}
        pending={false}
        error={null}
        starredFolderIds={stars}
        onClose={onClose}
        onMove={() => done("프로젝트 이동")}
      />
    );
  if (id === "session-move" || id === "document-move")
    return (
      <FolderMoveDialog
        open
        api={pageApi}
        currentFolderId={folder.id}
        sampleFolders={dialoguesFolders}
        starredFolderIds={stars}
        defaultTargets={dialoguesFolders.map((f) => ({ folderId: f.id, page: reviewFolder(f.name, f.id).page }))}
        onClose={onClose}
        onMove={async () => done("폴더 이동")}
      />
    );
  if (id === "session-rename")
    return (
      <RenameSessionDialog
        open
        input={input}
        onInputChange={setInput}
        onOpenChange={openChange}
        onSubmit={() => {
          api.local.sessionName = input;
          done(`세션 이름 변경 · ${input}`);
        }}
      />
    );
  if (id === "session-delete" || id === "sessions-delete")
    return (
      <SessionDeleteDialog
        open
        count={id === "session-delete" ? 1 : 3}
        onOpenChange={openChange}
        onConfirm={() => done("세션 삭제")}
      />
    );
  if (id === "continue-error")
    return (
      <SessionContinueErrorDialog
        error="샘플 세션을 이어서 시작하지 못했습니다. 입력과 취소 동작을 확인합니다."
        onClose={onClose}
      />
    );
  if (id === "new-session" || id === "succession")
    return (
      <SessionSuccessionModal
        folderTitle={folder.name}
        folderPageId={folder.id}
        folderId={folder.id}
        contextItems={[{ id: "sample", icon: "📄", label: "검수 컨텍스트" }]}
        documentOptions={[{ pageId: "sample-document", title: "검수 문서" }]}
        contextPending={false}
        predecessorOptions={
          id === "succession"
            ? [{ sessionId: reviewSession.agentSessionId, label: "이전 검수 세션", runNumber: 1 }]
            : []
        }
        pageDefaults={{
          nodeId: "sample-node",
          agentId: "roselin",
          modelPreset: "sample-sol",
          sourcePageId: folder.id,
          sourceBlockId: "sample-defaults",
        }}
        currentSession={
          id === "succession" ? { ...reviewSession, nodeId: "sample-node", modelPreset: "sample-sol" } : null
        }
        assignment={dialoguesAssignment}
        atomRequest={api.request}
        uploadController={upload}
        actions={{
          createAnchor: async () => ({ pageId: folder.id, blockId: "sample-anchor", expectedVersion: 1 }),
          createSession: async () => {
            api.record("새 세션 생성");
            return { agentSessionId: "sample-created", status: "running", nodeId: "sample-node" };
          },
        }}
        onClose={onClose}
        onCreated={() => {
          onChanged();
        }}
      />
    );
  if (id === "search")
    return (
      <SessionMenuOwnerProvider onOpen={() => done("검색 결과 메뉴")}>
        <SearchModal
          open
          request={api.request}
          sessions={[reviewSession]}
          onOpenChange={openChange}
          onOpenSession={() => done("검색 세션 열기")}
          onOpenFolder={() => done("검색 폴더 열기")}
        />
      </SessionMenuOwnerProvider>
    );
  if (id === "card-create")
    return (
      <CardCreateDialog
        folders={dialoguesFolders}
        initialFolderId={folder.id}
        assignment={dialoguesAssignment}
        starredFolderIds={stars}
        uploadController={upload}
        onClose={onClose}
        onSave={async (value) => {
          api.local.cards.push(value);
          api.record(`카드 저장 · ${value.title}`);
          onChanged();
          return { id: "sample-created-card" };
        }}
      />
    );
  if (id === "document-delete")
    return (
      <MarkdownDeleteDialog open title="검수 문서" onOpenChange={openChange} onConfirm={() => done("문서 삭제")} />
    );
  if (id.startsWith("rename-"))
    return (
      <BoardRenameDialog
        kind={id === "rename-markdown" ? "markdown" : id === "rename-folder" ? "folder" : "frame"}
        value={input}
        onChange={setInput}
        onClose={onClose}
        onSubmit={() => done(`보드 이름 변경 · ${input}`)}
      />
    );
  if (id.startsWith("board-move-"))
    return (
      <BoardMoveDialog
        open
        pending={false}
        error={null}
        targets={dialoguesFolders.map((folder) => ({ id: folder.id, title: folder.name }))}
        selectedFolderId={selected}
        onSelect={setSelected}
        onMove={() => done("보드 항목 이동")}
        onClose={onClose}
      />
    );
  if (id === "settings" || id === "user-create" || id === "user-edit")
    return (
      <ConfigModal
        open
        api={api.config}
        initialTab={id === "settings" ? undefined : "users"}
        userEditor={id === "user-create" ? "create" : id === "user-edit" ? "edit" : undefined}
        onOpenChange={openChange}
      />
    );
  if (id === "ritual")
    return (
      <RitualModal
        open
        today="2026-10-03"
        reviewCount={1}
        onClose={onClose}
        onFocusSessionPanel={() => done("세션 패널 열기")}
        onActionApplied={() => {
          onChanged();
        }}
        actions={{
          load: async () => ({
            dailyPageId: "sample-daily",
            items: [
              {
                kind: "task",
                id: folder.id,
                title: "어제에서 넘어온 폴더",
                description: "오늘 할 일을 결정합니다.",
                agentLabel: "로젤린",
                sourceDate: "2026-10-02",
                sourcePageId: "sample-yesterday",
                task: reviewFolder(folder.name, folder.id),
              },
            ],
          }),
          apply: async (_, action) => {
            api.record(`아침 정리 · ${action}`);
          },
        }}
      />
    );
  return <DialoguesOverlaySamples id={id} api={api} onClose={onClose} onChanged={onChanged} />;
}
