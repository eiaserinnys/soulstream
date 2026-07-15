import { useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@seosoyoung/soul-ui";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

export function NewTaskForm({
  folders,
  initialFolderId,
  pending,
  onCreate,
  onCancel,
}: {
  folders: readonly CatalogFolder[];
  initialFolderId: string | null;
  pending: boolean;
  onCreate(title: string, folderId: string, description: string): void;
  onCancel(): void;
}) {
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState(initialFolderId ?? folders[0]?.id ?? "");
  const [description, setDescription] = useState("");

  const selected = folders.find((folder) => folder.id === folderId);
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
            <p>상속 미리보기: {selected?.name ?? "프로젝트"}의 guidance · atom · 실행 기본값</p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <button type="button" className="v3-button v3-button--ghost" onClick={onCancel} disabled={pending}>취소</button>
          <button type="button" className="v3-button v3-button--primary" onClick={submit} disabled={pending || !title.trim() || !folderId}>
            {pending ? "만드는 중…" : "업무 만들기"}
          </button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
