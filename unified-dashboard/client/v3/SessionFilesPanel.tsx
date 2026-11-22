import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, DashboardIconCap, FrameLoading, formatWorkspaceTime, type ChatSessionStoreScope } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { SessionWorkspaceResponse } from "../../../packages/wire-schema/src/session_workspace";
import { ChevronRight, Eye, File, GitBranch, GitCommitHorizontal, PencilLine, RefreshCw, WifiOff, X } from "lucide-react";
import "./session-files.css";
import { useSessionFilesTurn } from "./use-session-files-turn";

type Entry = SessionWorkspaceResponse["files"][number] | SessionWorkspaceResponse["read_only"][number];
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
function asAttachment(sessionId: string, file: Entry): ChatAttachmentItem {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(file.path)}`;
  const name = file.path.split("/").at(-1) ?? file.path;
  const image = /\.(png|jpe?g|gif|webp|avif)$/i.test(name);
  return { key: file.path, name, mimeType: null, byteSize: image ? file.size : null, previewKind: image ? "image" : "text", availability: "ready", previewUrl: url, originalUrl: `${url}&download=true`, legacySources: [], source: { kind: "unavailable", path: file.path, context: { type: "session", id: sessionId } } };
}

export function SessionFilesPanel({ sessionId, data, loading, error, onRefresh, onClose, focusOnMount = false, scrollTop = 0, onScroll, initiallyExpanded = false, onExpandedChange }: {
  sessionId: string; data: SessionWorkspaceResponse | null; loading: boolean; error: boolean; onRefresh(): void; onClose(): void; focusOnMount?: boolean; scrollTop?: number; onScroll?(position: number): void; initiallyExpanded?: boolean; onExpandedChange?(value: boolean): void;
}) {
  const [showRead, setShowRead] = useState(initiallyExpanded);
  const [selected, setSelected] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusOnMount) refreshRef.current?.focus({ preventScroll: true }); }, [focusOnMount]);
  useLayoutEffect(() => { if (data && scrollRef.current) scrollRef.current.scrollTop = scrollTop; }, [data?.session_id, data?.snapshot?.state, Boolean(data), scrollTop]);
  useEffect(() => { setShowRead(initiallyExpanded); setSelected(null); }, [sessionId]);
  const changed = data?.files ?? [];
  const readOnly = data?.read_only ?? [];
  const entries = useMemo(() => [...grouped(changed).flatMap(([, files]) => files), ...(showRead ? grouped(readOnly).flatMap(([, files]) => files) : [])], [data, showRead]);
  const items = entries.map(file => asAttachment(sessionId, file));
  const index = selected === null ? null : entries.findIndex(file => file.path === selected);
  const initial = !data || (data.node.status === "ok" && data.snapshot?.state === "pending");
  const busy = loading || Boolean(data?.snapshot?.refreshing);
  const rootName = data?.root?.split(/[\\/]/).filter(Boolean).at(-1);
  const tree = (files: Entry[]) => grouped(files).map(([dir, group]) => <div className="v3-session-files-group" key={dir}>
    {dir && <p className="v3-session-files-dir" title={dir}>{dir.split("/").map((part, i) => <span key={i}>{i > 0 && <>/<wbr/></>}{part}</span>)}</p>}
    {group.map(file => {
      const kind = activity(file); const Icon = kind === "write" ? PencilLine : kind === "commit" ? GitCommitHorizontal : kind === "read" ? Eye : File;
      const git = "git_status" in file ? file : null;
      const label = { read: "읽음", write: "이 세션이 고침", commit: "이 세션이 커밋함", none: "세션 기록 밖에서 바뀜" }[kind];
      return <button type="button" className="v3-session-files-row" key={file.path} title={`${file.path} · ${label}`} onClick={event => { setTrigger(event.currentTarget); setSelected(file.path); }}>
        <span className="v3-session-files-mark" data-activity={kind}><Icon className="h-4 w-4" aria-label={label}/></span>
        <span className="v3-session-files-name">{file.path.split("/").at(-1)}</span>
        {git && (git.git_status === "added" || git.git_status === "untracked") && <span className="v3-session-files-new">새</span>}
        {git && (git.added !== null || git.deleted !== null) && <span className="v3-session-files-diff">{git.added !== null && <span className="is-add">+{git.added}</span>}{git.deleted !== null && git.deleted > 0 && <span className="is-del">−{git.deleted}</span>}</span>}
      </button>;
    })}
  </div>);
  return <>
    <header className="v3-panel-header v3-chat-header">
      <div className="v3-chat-title-row"><div className="v3-chat-session-title v3-session-files-title">
        {initial && !error ? <span className="v3-session-files-skeleton" aria-label="브랜치 확인 중"/> : <>{data?.snapshot?.branch && <GitBranch className="h-4 w-4" aria-hidden="true"/>}<strong>{data?.snapshot?.branch ?? rootName ?? "파일"}</strong>{Boolean(data?.snapshot?.ahead) && <span>↑{data?.snapshot?.ahead}</span>}{Boolean(data?.snapshot?.behind) && <span>↓{data?.snapshot?.behind}</span>}</>}
      </div>
      <DashboardIconCap ref={refreshRef} size="small" label="다시 읽기" onClick={onRefresh}><RefreshCw className={`h-4 w-4${busy ? " animate-spin" : ""}`} aria-hidden="true"/></DashboardIconCap>
      <DashboardIconCap size="small" label="파일 닫기" onClick={onClose}><X className="h-4 w-4" aria-hidden="true"/></DashboardIconCap></div>
    </header>
    <div ref={scrollRef} onScroll={event => onScroll?.(event.currentTarget.scrollTop)} className="v3-session-panel-scroll v3-session-files-body">
      {data?.node.status === "offline" && <div className="v3-session-files-notice" role="status"><WifiOff className="h-4 w-4" aria-hidden="true"/>노드 끊김{data.snapshot?.observed_at && ` · ${formatWorkspaceTime(data.snapshot.observed_at)} 기준`}</div>}
      {error || data?.node.status === "error" ? <div className="v3-session-files-notice" role="alert"><span data-slot="dialog-error-message">파일을 불러오지 못했습니다.</span> <Button size="sm" variant="outline" onClick={onRefresh}>다시 시도</Button></div>
        : data?.node.status === "unsupported" ? <p>이 노드는 파일 보기를 지원하지 않습니다.</p>
        : data?.node.status === "no_workspace" ? <p>작업 폴더가 없습니다.</p>
        : initial && data?.node.status !== "offline" ? <FrameLoading label="파일 상태를 읽는 중"/>
        : <>
          {data?.snapshot?.state === "not_git" && <div className="v3-session-files-notice">Git 작업 폴더가 아닙니다</div>}
          <nav className="v3-nav-list v3-session-files-list" aria-label="세션 파일">
            {data?.attribution === "partial" && readOnly.length === 0 && <p title="이 엔진은 읽은 파일을 일부만 기록합니다">읽음 일부</p>}
            {changed.length ? tree(changed) : data?.snapshot?.state !== "not_git" && <p>바뀐 파일 없음</p>}
            {readOnly.length > 0 && <div className="v3-session-files-group"><button type="button" className="v3-session-files-row" aria-expanded={showRead} onClick={() => { const next = !showRead; setShowRead(next); onExpandedChange?.(next); }}><span className="v3-session-files-mark" data-activity="read"><Eye className="h-4 w-4" aria-hidden="true"/></span><span className="v3-session-files-name">읽기만 한 파일</span>{data?.attribution === "partial" && <span className="v3-session-files-new" title="이 엔진은 읽은 파일을 일부만 기록합니다">일부</span>}<span>{readOnly.length}</span><ChevronRight className={`h-4 w-4${showRead ? " v3-session-files-chevron-open" : ""}`} aria-hidden="true"/></button>{showRead && tree(readOnly)}</div>}
          </nav>
        </>}
    </div>
    <AttachmentViewer items={items} index={index !== null && index >= 0 ? index : null} onIndexChange={next => setSelected(entries[next]?.path ?? null)} onClose={() => setSelected(null)} returnFocus={trigger}/>
  </>;
}

export function SessionFilesPane({ sessionId, storeScope, onClose, scrollTop, onScroll, initiallyExpanded, onExpandedChange }: { sessionId: string; storeScope?: ChatSessionStoreScope; onClose(): void; scrollTop?: number; onScroll?(position: number): void; initiallyExpanded?: boolean; onExpandedChange?(value: boolean): void }) {
  const turnKey = useSessionFilesTurn(sessionId, storeScope);
  const state = useSessionFiles(sessionId, turnKey);
  return <section onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }} className="v3-detail-pane v3-session-files-pane border border-glass-border glass-strong glass-chrome lg-rim" aria-label="세션 파일"><SessionFilesPanel sessionId={sessionId} {...state} onRefresh={state.refresh} onClose={onClose} scrollTop={scrollTop} onScroll={onScroll} initiallyExpanded={initiallyExpanded} onExpandedChange={onExpandedChange} focusOnMount/></section>;
}
