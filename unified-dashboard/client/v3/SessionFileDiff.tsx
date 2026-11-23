import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties } from "react";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { Maximize2 } from "lucide-react";
import type { SessionWorkspaceDiffResponse, SessionWorkspaceResponse, WorkspaceGitStatus } from "../../../packages/wire-schema/src/session_workspace";

export type WorkspaceDiffStatus = WorkspaceGitStatus | "unchanged";
type ChangedFile = SessionWorkspaceResponse["files"][number];
type DiffLine = { kind: "hunk"; heading: string } | { kind: "add" | "del" | "ctx"; text: string; number: number };
type DiffState = { kind: "loading" } | { kind: "error" } | { kind: "unsupported" } | { kind: "ready"; data: SessionWorkspaceDiffResponse };
export const SessionFileDiffFetchContext = createContext<typeof fetch | null>(null);

const STATUS_LABEL: Record<WorkspaceDiffStatus, string> = {
  modified: "수정", added: "새 파일", untracked: "새 파일", deleted: "지움", renamed: "이름 바꿈",
  conflicted: "충돌", typechange: "형식 바뀜", unchanged: "바뀌지 않음",
};

/** unified diff를 줄로 나눈다. 줄 번호는 지금 파일 기준이라 지운 줄에는 그리지 않는다. 첫 헝크 앞의 파일 머리(diff --git, index, ---, +++)는 버린다. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) { inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      // 파일 맨 앞에서 시작하는 헝크는 건너뛴 줄이 없으니 띠를 두지 않는다.
      if (oldLine > 1 || newLine > 1) lines.push({ kind: "hunk", heading: hunk[3] });
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), number: newLine++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), number: oldLine++ });
    else if (raw.startsWith(" ")) { lines.push({ kind: "ctx", text: raw.slice(1), number: newLine++ }); oldLine++; }
  }
  return lines;
}

export function useSessionFileDiff(sessionId: string, file: ChangedFile, observedAt: string | null) {
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const request = useContext(SessionFileDiffFetchContext) ?? fetch;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setState(previous => previous.kind === "ready" ? previous : { kind: "loading" });
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/workspace/diff?path=${encodeURIComponent(file.path)}`;
    request(url, { credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        // 새 명령을 모르는 노드는 501로 온다. 다시 시도해도 같으니 실패와 가른다.
        if (controller.signal.aborted) return;
        if (response.status === 501) { setState({ kind: "unsupported" }); setBusy(false); return; }
        if (!response.ok) throw new Error("diff request failed");
        const data = await response.json() as SessionWorkspaceDiffResponse;
        if (!controller.signal.aborted) { setState({ kind: "ready", data }); setBusy(false); }
      })
      .catch(() => { if (!controller.signal.aborted) { setState({ kind: "error" }); setBusy(false); } });
    return () => controller.abort();
  }, [request, sessionId, file.path, file.git_status, file.added, file.deleted, observedAt, attempt]);
  return { state, busy, retry: () => setAttempt(value => value + 1) };
}

export function SessionFileDiff({ id, sessionId, file, observedAt, onOpenFull }: {
  id: string; sessionId: string; file: ChangedFile; observedAt: string | null; onOpenFull(trigger: HTMLElement): void;
}) {
  const { state, busy, retry } = useSessionFileDiff(sessionId, file, observedAt);
  const status: WorkspaceDiffStatus = state.kind === "ready" ? state.data.status : file.git_status ?? "modified";
  const lines = useMemo(() => state.kind === "ready" && !state.data.binary ? parseUnifiedDiff(state.data.text) : [], [state]);
  const digits = String(lines.reduce((max, line) => line.kind === "hunk" || line.kind === "del" ? max : Math.max(max, line.number), 1)).length;
  const name = file.path.split("/").at(-1) ?? file.path;
  // 같은 폴더 안의 이름 바꿈이면 옛 이름만, 폴더가 바뀌었으면 옛 경로 전체를 보인다.
  const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const from = status === "renamed" && file.orig_path ? (dir(file.orig_path) === dir(file.path) ? file.orig_path.split("/").at(-1) ?? file.orig_path : file.orig_path) : null;
  return <div id={id} role="region" aria-label={`${name} 변경분`} aria-busy={busy} className="v3-session-file-diff">
    <div className="v3-session-file-diff-head">
      <span className="v3-session-file-diff-status">{STATUS_LABEL[status]}</span>
      {from && <span className="v3-session-file-diff-from" title={file.orig_path ?? undefined}><span>{from}</span><span>에서</span></span>}
      {status !== "deleted" && <DashboardIconCap appearance="bare" size="small" label="전체 보기" onClick={event => onOpenFull(event.currentTarget)}>
        <Maximize2 className="h-4 w-4" aria-hidden="true"/>
      </DashboardIconCap>}
    </div>
    {state.kind === "loading" ? <div className="v3-session-file-diff-skeleton" aria-label="변경분을 읽는 중"><span/><span/><span/><span/></div>
      : state.kind === "error" ? <div className="v3-session-file-diff-state" role="alert"><span data-slot="dialog-error-message">변경분을 불러오지 못했습니다</span><Button size="sm" variant="outline" onClick={retry}>다시 시도</Button></div>
      : state.kind === "unsupported" ? <div className="v3-session-file-diff-state">이 노드는 아직 변경분을 보이지 않습니다</div>
      : state.data.binary ? <div className="v3-session-file-diff-state">바이너리 파일</div>
      : lines.length === 0 ? <div className="v3-session-file-diff-state">바뀐 내용 없음</div>
      : <div className="v3-session-file-diff-body" tabIndex={0} aria-label={`${name} 변경 줄`} style={{ "--v3-diff-digits": digits } as CSSProperties}>
        {lines.map((line, index) => line.kind === "hunk"
          ? <div key={index} className="v3-session-file-diff-line" data-kind="hunk"><span className="v3-session-file-diff-num" aria-hidden="true">⋯</span><span/><span className="v3-session-file-diff-code">{line.heading}</span></div>
          : <div key={index} className="v3-session-file-diff-line" data-kind={line.kind}>
            <span className="v3-session-file-diff-num">{line.kind === "del" ? "" : line.number}</span>
            <span className="v3-session-file-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
            <span className="v3-session-file-diff-code" data-v3-selectable-content="true">{line.text || " "}</span>
          </div>)}
      </div>}
    {state.kind === "ready" && state.data.truncated && <div className="v3-session-file-diff-foot">앞 512KiB만 보입니다</div>}
  </div>;
}
