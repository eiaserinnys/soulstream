import { useEffect, useRef, useState } from "react";
import type { PageDto } from "@seosoyoung/soul-ui/page";

export function NewTaskForm({
  projects,
  initialProjectId,
  pending,
  onCreate,
  onCancel,
}: {
  projects: readonly PageDto[];
  initialProjectId: string | null;
  pending: boolean;
  onCreate(title: string, projectId: string): void;
  onCancel(): void;
}) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  const selected = projects.find((project) => project.id === projectId);
  const submit = () => {
    const normalized = title.trim();
    if (!normalized || !projectId || pending) return;
    onCreate(normalized, projectId);
  };

  return (
    <div className="v3-new-task" role="group" aria-label="새 업무 만들기">
      <input
        ref={inputRef}
        value={title}
        disabled={pending}
        placeholder="새 업무 제목… Enter로 만들기"
        aria-label="새 업무 제목"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); submit(); }
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }}
      />
      <select
        value={projectId}
        disabled={pending}
        aria-label="프로젝트 선택"
        onChange={(event) => setProjectId(event.target.value)}
      >
        {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <button type="button" className="v3-button v3-button--ghost" onClick={onCancel} disabled={pending}>
        취소
      </button>
      <button type="button" className="v3-button v3-button--primary" onClick={submit} disabled={pending || !title.trim() || !projectId}>
        {pending ? "만드는 중…" : "만들기"}
      </button>
      <p>
        상속 미리보기: {selected?.title ?? "프로젝트"}의 guidance · atom · 실행 기본값
      </p>
    </div>
  );
}
