import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, DashboardIconCap, DisclosureActionIcon, FrameLoading, formatWorkspaceTime, type ChatSessionStoreScope } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { SessionWorkspaceResponse } from "../../../packages/wire-schema/src/session_workspace";
import { Eye, File, GitBranch, GitCommitHorizontal, PencilLine, RefreshCw, SquareTerminal, WifiOff, X } from "lucide-react";
import { useSessionFilesTurn } from "./use-session-files-turn";
import { SessionFileDiff } from "./SessionFileDiff";
import "./session-files.css";
import "./v3-persistent-task-list.css";

type ChangedFile = SessionWorkspaceResponse["files"][number];
type Entry = ChangedFile | SessionWorkspaceResponse["read_only"][number];
type ViewState = { data: SessionWorkspaceResponse | null; loading: boolean; error: boolean };

export function useSessionFiles(sessionId: string, turnKey?: string | number | null) {
  const [state, setState] = useState<ViewState>({ data: null, loading: true, error: false });
  const [revision, setRevision] = useState(0);
  const previousTurn = useRef(turnKey);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (previousTurn.current !== turnKey) { previousTurn.current = turnKey; refresh(); }
  }, [turnKey, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    setState(previous => ({ data: previous.data?.session_id === sessionId ? previous.data : null, loading: true, error: false }));
    const load = async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error("workspace request failed");
        const data = await response.json() as SessionWorkspaceResponse;
        if (controller.signal.aborted) return;
        setState({ data, loading: false, error: false });
        if ((data.snapshot?.state === "pending" || data.snapshot?.refreshing) && retries < 10) {
          retries += 1;
          timer = setTimeout(() => void load(), 3000);
        }
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: true }));
      }
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, revision]);
  return state.data && state.data.session_id !== sessionId
    ? { data: null, loading: true, error: false, refresh }
    : { ...state, refresh };
}
const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

function activity(file: Entry): "read" | "write" | "commit" | "none" {
  if (!("wrote" in file)) return "read";
  return file.committed ? "commit" : file.wrote ? "write" : file.read ? "read" : "none";
}
function grouped(files: Entry[]) {
  const groups = new Map<string, Entry[]>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups];
}
function ordered(files: Entry[]) { return grouped(files).flatMap(([, group]) => group); }
function asAttachment(sessionId: string, file: Entry): ChatAttachmentItem {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(file.path)}`;
  const name = file.path.split("/").at(-1) ?? file.path;
  const image = IMAGE.test(name);
  return { key: file.path, name, mimeType: null, byteSize: image ? file.size : null, previewKind: image ? "image" : "text", availability: "ready", previewUrl: url, originalUrl: `${url}&download=true`, legacySources: [], source: { kind: "unavailable", path: file.path, context: { type: "session", id: sessionId } } };
}
/** git 변경이 있는 행만 그 자리에서 diff를 편다. 그림 파일과 Git이 아닌 폴더는 바로 전체 보기다. */
function diffable(file: Entry, notGit: boolean, noWorkspace: boolean): file is ChangedFile {
  return "git_status" in file && !IMAGE.test(file.path) && (file.wrote || (!noWorkspace && !notGit && file.git_status !== null));
}

/** PAS 작업 목록의 접는 묶음 머리(v3-persistent-task-group-toggle)를 그대로 쓴다. */
function Section({ title, count, open, onToggle, badge, children }: { title: string; count: number; open: boolean; onToggle(): void; badge?: ReactNode; children: ReactNode }) {
  return <section className="v3-session-files-section" aria-label={title}>
    <div className="v3-detail-section-head"><h3>
      <button type="button" className="v3-persistent-task-group-toggle outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={open} onClick={onToggle}>
        <span className="v3-persistent-task-group-name">{title}</span>
        <span className="v3-persistent-task-group-count">{count}개</span>
        {badge}
        <DisclosureActionIcon expanded={open} className="h-4 w-4"/>
      </button>
    </h3></div>
    {open && <div className="v3-nav-list v3-session-files-list">{children}</div>}
  </section>;
}

export function SessionFilesPanel({ sessionId, data, loading, error, onRefresh, onClose, focusOnMount = false, scrollTop = 0, onScroll, initiallyExpanded = false, onExpandedChange, initiallySessionOpen = true, initiallyOtherOpen = false, onSectionChange }: {
  sessionId: string; data: SessionWorkspaceResponse | null; loading: boolean; error: boolean; onRefresh(): void; onClose(): void; focusOnMount?: boolean; scrollTop?: number; onScroll?(position: number): void; initiallyExpanded?: boolean; onExpandedChange?(value: boolean): void; initiallySessionOpen?: boolean; initiallyOtherOpen?: boolean; onSectionChange?(section: "session" | "other", value: boolean): void;
}) {
  const [showSession, setShowSession] = useState(initiallySessionOpen);
  const [showRead, setShowRead] = useState(initiallyExpanded);
  const [showOther, setShowOther] = useState(initiallyOtherOpen);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const diffId = useId();
  useEffect(() => { if (focusOnMount) refreshRef.current?.focus({ preventScroll: true }); }, [focusOnMount]);
  useLayoutEffect(() => { if (data && scrollRef.current) scrollRef.current.scrollTop = scrollTop; }, [data?.session_id, data?.snapshot?.state, Boolean(data), scrollTop]);
  useEffect(() => { setShowSession(initiallySessionOpen); setShowRead(initiallyExpanded); setShowOther(initiallyOtherOpen); setOpenDiff(null); setViewing(null); }, [sessionId]);

  const notGit = data?.snapshot?.state === "not_git";
  const noWorkspace = data?.node.status === "no_workspace";
  const files = data?.files ?? [];
  const wrote = useMemo(() => files.filter(file => file.wrote), [data]);
  const reads = useMemo<Entry[]>(() => [...files.filter(file => !file.wrote && file.read), ...(data?.read_only ?? [])], [data]);
  const others = useMemo(() => files.filter(file => !file.wrote && !file.read && file.git_status !== null), [data]);
  const visible = useMemo(() => noWorkspace ? [] : [...(showSession ? [...ordered(wrote), ...(showRead ? ordered(reads) : [])] : []), ...(showOther ? ordered(others) : [])], [wrote, reads, others, showSession, showRead, showOther, noWorkspace]);
  const items = visible.map(file => asAttachment(sessionId, file));
  const index = viewing === null ? null : visible.findIndex(file => file.path === viewing);
  const initial = !data || (data.node.status === "ok" && data.snapshot?.state === "pending");
  const busy = loading || Boolean(data?.snapshot?.refreshing);
  const rootName = data?.root?.split(/[\\/]/).filter(Boolean).at(-1);

  const view = (file: Entry, button: HTMLElement) => { setTrigger(button); setViewing(file.path); };
  const row = (file: Entry) => {
    const kind = activity(file); const Icon = kind === "write" ? PencilLine : kind === "commit" ? GitCommitHorizontal : kind === "read" ? Eye : File;
    const git = "git_status" in file ? file : null;
    const label = { read: "읽음", write: "이 세션이 고침", commit: "이 세션이 커밋함", none: "세션 기록 밖에서 바뀜" }[kind];
    const canDiff = diffable(file, notGit, noWorkspace);
    const live = !!git && !noWorkspace && !notGit && git.git_status !== null && !IMAGE.test(file.path);
    const history = !!git?.wrote && !IMAGE.test(file.path);
    const open = canDiff && openDiff === file.path;
    const rowDiffId = `${diffId}-${encodeURIComponent(file.path)}`;
    return <div className={`v3-session-files-entry${open ? " is-open" : ""}`} key={file.path}>
      {noWorkspace && !canDiff ? <div className="v3-session-files-row" title={`${file.path} · ${label}`}>
        <span className="v3-session-files-mark" data-activity={kind}><Icon className="h-4 w-4" aria-label={label}/></span><span className="v3-session-files-name">{file.path.split("/").at(-1)}</span>
      </div> : <button type="button" className="v3-session-files-row" title={`${file.path} · ${label}`} aria-expanded={canDiff ? open : undefined} aria-controls={canDiff ? rowDiffId : undefined}
        onClick={event => canDiff ? setOpenDiff(open ? null : file.path) : view(file, event.currentTarget)}>
        <span className="v3-session-files-mark" data-activity={kind}><Icon className="h-4 w-4" aria-label={label}/></span>
        <span className="v3-session-files-name">{file.path.split("/").at(-1)}</span>
        {git && (git.git_status === "added" || git.git_status === "untracked") && <span className="v3-session-files-new">새</span>}
        {git && (git.added !== null || git.deleted !== null) && <span className="v3-session-files-diff">{git.added !== null && git.added > 0 && <span className="is-add">+{git.added}</span>}{git.deleted !== null && git.deleted > 0 && <span className="is-del">−{git.deleted}</span>}</span>}
      </button>}
      {open && <SessionFileDiff key={file.path} id={rowDiffId} sessionId={sessionId} file={file} observedAt={data?.snapshot?.observed_at ?? null} live={live} history={history} noWorkspace={noWorkspace} onOpenFull={button => view(file, button)}/>}
    </div>;
  };
  const tree = (list: Entry[]) => grouped(list).map(([dir, group]) => <div className="v3-session-files-group" key={dir}>
    {dir && <p className="v3-session-files-dir" title={dir}>{dir.split("/").map((part, i) => <span key={i}>{i > 0 && <>/<wbr/></>}{part}</span>)}</p>}
    {group.map(row)}
  </div>);

  return <>
    <header className="v3-panel-header v3-chat-header">
      <div className="v3-chat-title-row"><div className="v3-chat-session-title v3-session-files-title">
        {initial && !error ? <span className="v3-session-files-skeleton" aria-label="브랜치 확인 중"/> : <>{data?.snapshot?.branch && <GitBranch className="h-4 w-4" aria-hidden="true"/>}<strong title={data?.snapshot?.branch ?? undefined}>{data?.snapshot?.branch ?? rootName ?? "파일"}</strong>{Boolean(data?.snapshot?.ahead) && <span>↑{data?.snapshot?.ahead}</span>}{Boolean(data?.snapshot?.behind) && <span>↓{data?.snapshot?.behind}</span>}</>}
      </div>
      <DashboardIconCap ref={refreshRef} size="small" label="다시 읽기" onClick={onRefresh}><RefreshCw className={`h-4 w-4${busy ? " animate-spin" : ""}`} aria-hidden="true"/></DashboardIconCap>
      <DashboardIconCap size="small" label="파일 닫기" onClick={onClose}><X className="h-4 w-4" aria-hidden="true"/></DashboardIconCap></div>
    </header>
    <div ref={scrollRef} onScroll={event => onScroll?.(event.currentTarget.scrollTop)} className="v3-session-panel-scroll v3-session-files-body">
      {data?.node.status === "offline" && <div className="v3-session-files-notice" role="status"><WifiOff className="h-4 w-4" aria-hidden="true"/>노드 끊김{data.snapshot?.observed_at && ` · ${formatWorkspaceTime(data.snapshot.observed_at)} 기준`}</div>}
      {error || data?.node.status === "error" ? <div className="v3-session-files-notice" role="alert"><span data-slot="dialog-error-message">파일을 불러오지 못했습니다.</span> <Button size="sm" variant="outline" onClick={onRefresh}>다시 시도</Button></div>
        : data?.node.status === "unsupported" ? <div className="v3-nav-list v3-session-files-list"><p>이 노드는 파일 보기를 지원하지 않습니다.</p></div>
        : noWorkspace && !files.length && !(data?.read_only.length) ? <div className="v3-nav-list v3-session-files-list"><p>작업 폴더가 없습니다.</p></div>
        : initial && data?.node.status !== "offline" ? <FrameLoading label="파일 상태를 읽는 중"/>
        : <>
          {noWorkspace && <div className="v3-session-files-notice">작업 폴더가 지워져 이 세션이 고친 내용만 볼 수 있습니다</div>}
          {notGit && <div className="v3-session-files-notice">Git 작업 폴더가 아닙니다</div>}
          <nav className="v3-session-files-sections" aria-label="세션 파일">
            {wrote.length === 0 && reads.length === 0 && others.length === 0 && !notGit && <div className="v3-nav-list v3-session-files-list"><p>바뀐 파일 없음</p></div>}
            {(wrote.length > 0 || reads.length > 0) && <Section title="이번 세션" count={wrote.length} open={showSession} onToggle={() => { const next = !showSession; setShowSession(next); onSectionChange?.("session", next); }}
              badge={data?.attribution === "partial" && <span className="v3-session-files-new" title="이 엔진은 활동 기록을 일부만 남깁니다">일부</span>}>
              {tree(wrote)}
              {reads.length > 0 && <div className="v3-session-files-group"><button type="button" className="v3-session-files-row" aria-expanded={showRead} onClick={() => { const next = !showRead; setShowRead(next); onExpandedChange?.(next); }}><span className="v3-session-files-mark" data-activity="read"><Eye className="h-4 w-4" aria-hidden="true"/></span><span className="v3-session-files-name">읽기만 한 파일</span><span className="v3-session-files-count">{reads.length}개</span><DisclosureActionIcon expanded={showRead} className="h-4 w-4"/></button>{showRead && tree(reads)}</div>}
            </Section>}
            {others.length > 0 && <Section title="다른 변경" count={others.length} open={showOther} onToggle={() => { const next = !showOther; setShowOther(next); onSectionChange?.("other", next); }}>
              <div className="v3-session-files-notice v3-session-files-hint"><SquareTerminal className="h-4 w-4" aria-hidden="true"/>셸로 고친 파일은 여기 나옵니다</div>
              {tree(others)}
            </Section>}
          </nav>
        </>}
    </div>
    <AttachmentViewer items={items} index={index !== null && index >= 0 ? index : null} onIndexChange={next => setViewing(visible[next]?.path ?? null)} onClose={() => setViewing(null)} returnFocus={trigger}/>
  </>;
}

export function SessionFilesPane({ sessionId, storeScope, onClose, scrollTop, onScroll, initiallyExpanded, onExpandedChange, initiallySessionOpen, initiallyOtherOpen, onSectionChange }: { sessionId: string; storeScope?: ChatSessionStoreScope; onClose(): void; scrollTop?: number; onScroll?(position: number): void; initiallyExpanded?: boolean; onExpandedChange?(value: boolean): void; initiallySessionOpen?: boolean; initiallyOtherOpen?: boolean; onSectionChange?(section: "session" | "other", value: boolean): void }) {
  const turnKey = useSessionFilesTurn(sessionId, storeScope);
  const state = useSessionFiles(sessionId, turnKey);
  return <section onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }} className="v3-detail-pane v3-session-files-pane border border-glass-border glass-strong glass-chrome lg-rim" aria-label="세션 파일"><SessionFilesPanel sessionId={sessionId} {...state} onRefresh={state.refresh} onClose={onClose} scrollTop={scrollTop} onScroll={onScroll} initiallyExpanded={initiallyExpanded} onExpandedChange={onExpandedChange} initiallySessionOpen={initiallySessionOpen} initiallyOtherOpen={initiallyOtherOpen} onSectionChange={onSectionChange} focusOnMount/></section>;
}
