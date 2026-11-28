import { useTranslation } from "react-i18next";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { formatWorkspaceTime } from "./v3-dashboard-utils";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { Maximize2 } from "lucide-react";
import type { SessionWorkspaceDiffResponse, SessionWorkspaceResponse, SessionWorkspaceSessionDiffResponse, WorkspaceGitStatus } from "../../../packages/wire-schema/src/session_workspace";
import { DetailTabs } from "./DetailTabs";

export type WorkspaceDiffStatus = WorkspaceGitStatus | "unchanged";
type ChangedFile = SessionWorkspaceResponse["files"][number];
type DiffLine = { kind: "hunk"; heading: string } | { kind: "add" | "del" | "ctx"; text: string; number: number | null };
type DiffState = { kind: "loading" } | { kind: "error" } | { kind: "unsupported" } | { kind: "ready"; data: SessionWorkspaceDiffResponse };
export const SessionFileDiffFetchContext = createContext<typeof fetch | null>(null);

const STATUS_LABEL_KEY: Record<WorkspaceDiffStatus, string> = {
  modified: "sessions.fileModified", added: "sessions.fileAdded", untracked: "sessions.fileAdded", deleted: "sessions.fileDeleted", renamed: "sessions.fileRenamed",
  conflicted: "sessions.fileConflicted", typechange: "sessions.fileTypeChanged", unchanged: "sessions.fileUnchanged",
};

/** unified diff를 줄로 나눈다. 줄 번호는 지금 파일 기준이라 지운 줄에는 그리지 않는다. 첫 헝크 앞의 파일 머리(diff --git, index, ---, +++)는 버린다. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let numbered = true;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) { inHunk = false; continue; }
    if (raw === "@@ @@") { inHunk = true; numbered = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (hunk) {
      numbered = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      // 파일 맨 앞에서 시작하는 헝크는 건너뛴 줄이 없으니 띠를 두지 않는다.
      if (oldLine > 1 || newLine > 1) lines.push({ kind: "hunk", heading: hunk[3] });
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), number: numbered ? newLine++ : null });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), number: numbered ? oldLine++ : null });
    else if (raw.startsWith(" ")) { lines.push({ kind: "ctx", text: raw.slice(1), number: numbered ? newLine++ : null }); if (numbered) oldLine++; }
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

export function SessionFileDiff({ id, sessionId, file, observedAt, onOpenFull, live = true, history = false, noWorkspace = false }: {
  id: string; sessionId: string; file: ChangedFile; observedAt: string | null; onOpenFull(trigger: HTMLElement): void; live?: boolean; history?: boolean; noWorkspace?: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"live" | "history">(live ? "live" : "history");
  const [lastLiveStatus, setLastLiveStatus] = useState<WorkspaceDiffStatus>(file.git_status ?? "modified");
  const tabChanged=useRef(false);
  const selected = tab === "live" && live ? "live" : history ? "history" : "live";
  useEffect(()=>{ if (tabChanged.current) { document.getElementById(`${id}-tabs-${selected}`)?.focus(); tabChanged.current=false; } },[id,selected]);
  const tabs=live && history ? <DetailTabs id={`${id}-tabs`} label={t("sessions.diffSource")} panelId={id} tabs={[["live", t("sessions.uncommittedChanges")], ["history", t("sessions.sessionHistory")]] as const} value={selected} onChange={value=>{tabChanged.current=true;setTab(value);}}/> : null;
  return <div className="v3-session-file-diff-shell">
    {selected === "live" ? <LiveDiff id={id} sessionId={sessionId} file={file} observedAt={observedAt} onOpenFull={onOpenFull} tabs={tabs} previousStatus={lastLiveStatus} onStatusChange={setLastLiveStatus}/> : <SessionHistory id={id} sessionId={sessionId} file={file} noWorkspace={noWorkspace} onOpenFull={onOpenFull} tabs={tabs} liveStatus={tabs ? lastLiveStatus : null}/>}
  </div>;
}

function LiveDiff({ id, sessionId, file, observedAt, onOpenFull, tabs, previousStatus, onStatusChange }: { id:string; sessionId:string; file:ChangedFile; observedAt:string|null; onOpenFull(trigger:HTMLElement):void; tabs:ReactNode; previousStatus:WorkspaceDiffStatus; onStatusChange(status:WorkspaceDiffStatus):void }) {
  const { t } = useTranslation();
  const { state, busy, retry } = useSessionFileDiff(sessionId, file, observedAt);
  const status: WorkspaceDiffStatus = state.kind === "ready" ? state.data.status : tabs ? previousStatus : file.git_status ?? "modified";
  useEffect(() => { onStatusChange(status); }, [onStatusChange, status]);
  const lines = useMemo(() => state.kind === "ready" && !state.data.binary ? parseUnifiedDiff(state.data.text) : [], [state]);
  const digits = String(lines.reduce((max, line) => line.kind === "hunk" || line.kind === "del" ? max : Math.max(max, line.number ?? 0), 1)).length;
  const name = file.path.split("/").at(-1) ?? file.path;
  // 같은 폴더 안의 이름 바꿈이면 옛 이름만, 폴더가 바뀌었으면 옛 경로 전체를 보인다.
  const dir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const from = status === "renamed" && file.orig_path ? (dir(file.orig_path) === dir(file.path) ? file.orig_path.split("/").at(-1) ?? file.orig_path : file.orig_path) : null;
  return <div id={id} role="region" aria-label={t("sessions.diffTitle", { name })} aria-busy={busy} className="v3-session-file-diff">
    <div className="v3-session-file-diff-head">
      <span className="v3-session-file-diff-status">{t(STATUS_LABEL_KEY[status])}</span>
      {from && <span className="v3-session-file-diff-from" title={file.orig_path ?? undefined}><span>{from}</span><span>{t("sessions.renamedFrom")}</span></span>}
      {status !== "deleted" && <DashboardIconCap appearance="bare" size="small" label={t("sessions.viewFull")} onClick={event => onOpenFull(event.currentTarget)}>
        <Maximize2 className="h-4 w-4" aria-hidden="true"/>
      </DashboardIconCap>}
    </div>
    {tabs}
    {state.kind === "loading" ? <div className="v3-session-file-diff-skeleton" aria-label={t("sessions.diffLoading")}><span/><span/><span/><span/></div>
      : state.kind === "error" ? <div className="v3-session-file-diff-state" role="alert"><span data-slot="dialog-error-message">{t("sessions.diffLoadFailed")}</span><Button size="sm" variant="outline" onClick={retry}>{t("sessions.retry")}</Button></div>
      : state.kind === "unsupported" ? <div className="v3-session-file-diff-state">{t("sessions.diffUnsupported")}</div>
      : state.data.binary ? <div className="v3-session-file-diff-state">{t("sessions.binaryFile")}</div>
      : lines.length === 0 ? <div className="v3-session-file-diff-state">{t("sessions.noChanges")}</div>
      : <div className="v3-session-file-diff-body" tabIndex={0} aria-label={t("sessions.diffLines", { name })} style={{ "--v3-diff-digits": digits } as CSSProperties}>
        <DiffLines lines={lines}/>
      </div>}
    {state.kind === "ready" && state.data.truncated && <div className="v3-session-file-diff-foot">{t("sessions.diffTruncated")}</div>}
  </div>;
}

function DiffLines({lines}: {lines:DiffLine[]}) {
  return <>{lines.map((line, index) => line.kind === "hunk"
    ? <div key={index} className="v3-session-file-diff-line" data-kind="hunk"><span className="v3-session-file-diff-num" aria-hidden="true">⋯</span><span/><span className="v3-session-file-diff-code">{line.heading}</span></div>
    : <div key={index} className="v3-session-file-diff-line" data-kind={line.kind}>
      <span className="v3-session-file-diff-num">{line.kind === "del" ? "" : line.number}</span>
      <span className="v3-session-file-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
      <span className="v3-session-file-diff-code" data-v3-selectable-content="true">{line.text || " "}</span>
    </div>)}</>;
}

function SessionHistory({id,sessionId,file,noWorkspace,onOpenFull,tabs,liveStatus}: {id:string;sessionId:string;file:ChangedFile;noWorkspace:boolean;onOpenFull(trigger:HTMLElement):void;tabs:ReactNode;liveStatus:WorkspaceDiffStatus|null}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const formatNumber = new Intl.NumberFormat(language).format;
  const [state,setState]=useState<{kind:"loading"}|{kind:"error"}|{kind:"ready";data:SessionWorkspaceSessionDiffResponse}>({kind:"loading"});
  const [busy,setBusy]=useState(true);
  const [attempt,setAttempt]=useState(0);
  const request=useContext(SessionFileDiffFetchContext) ?? fetch;
  useEffect(() => {
    const controller=new AbortController();
    setBusy(true);
    setState(previous => previous.kind === "ready" ? previous : {kind:"loading"});
    request(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/session-diff?path=${encodeURIComponent(file.path)}`,{credentials:"same-origin",signal:controller.signal})
      .then(async response => { if (!response.ok) throw new Error("session diff request failed"); const data=await response.json() as SessionWorkspaceSessionDiffResponse; if (!controller.signal.aborted) { setState({kind:"ready",data}); setBusy(false); } })
      .catch(() => { if (!controller.signal.aborted) { setState({kind:"error"}); setBusy(false); } });
    return () => controller.abort();
  },[request,sessionId,file.path,file.last_activity_at,attempt]);
  const name=file.path.split("/").at(-1) ?? file.path;
  const data=state.kind === "ready" ? state.data : null;
  const allLines=data?.edits.map(edit => parseUnifiedDiff(edit.text)) ?? [];
  const digits=String(allLines.flat().reduce((max,line)=>line.kind === "hunk" || line.kind === "del" ? max : Math.max(max,line.number ?? 0),1)).length;
  return <div id={id} role="region" aria-label={t("sessions.diffTitle", { name })} aria-busy={busy} className="v3-session-file-diff">
    <div className="v3-session-file-diff-head"><span className="v3-session-file-diff-status">{liveStatus ? t(STATUS_LABEL_KEY[liveStatus]) : t("sessions.sessionHistory")}</span>
      {!noWorkspace && file.git_status !== "deleted" && <DashboardIconCap appearance="bare" size="small" label={t("sessions.viewFull")} onClick={event=>onOpenFull(event.currentTarget)}><Maximize2 className="h-4 w-4" aria-hidden="true"/></DashboardIconCap>}
    </div>
    {tabs}
    {state.kind === "loading" ? <div className="v3-session-file-diff-skeleton" aria-label={t("sessions.diffLoading")}><span/><span/><span/><span/></div>
      : state.kind === "error" ? <div className="v3-session-file-diff-state" role="alert"><span data-slot="dialog-error-message">{t("sessions.diffLoadFailed")}</span><Button size="sm" variant="outline" onClick={()=>setAttempt(value=>value+1)}>{t("sessions.retry")}</Button></div>
      : <div className="v3-session-file-diff-body" tabIndex={0} aria-label={t("sessions.diffLines", { name })} style={{"--v3-diff-digits":digits} as CSSProperties}>
        {state.data.edits.map((edit,index) => <div key={index}>
          <div className="v3-session-file-diff-edit-head">{formatNumber(index + 1)}/{formatNumber(state.data.edits.length)} · {formatWorkspaceTime(edit.at, language)} · {edit.kind === "edit" ? edit.replace_all ? t("sessions.replaceAll") : t("sessions.edited") : {write:t("sessions.overwritten"),add:t("sessions.fileAdded"),delete:t("sessions.fileDeleted")}[edit.kind]}</div>
          <DiffLines lines={allLines[index]}/>
        </div>)}
        {state.data.unrecorded > 0 && <div className="v3-session-file-diff-state">{state.data.edits.length ? t("sessions.unrecordedEdits", { count: formatNumber(state.data.unrecorded) }) : t("sessions.editsNotRecorded")}</div>}
        {!state.data.edits.length && !state.data.unrecorded && <div className="v3-session-file-diff-state">{t("sessions.noChanges")}</div>}
      </div>}
    {data?.truncated && <div className="v3-session-file-diff-foot">{t("sessions.historyTruncated")}</div>}
  </div>;
}
