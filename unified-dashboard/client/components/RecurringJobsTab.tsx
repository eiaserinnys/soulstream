import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  NewSessionFolderSelector,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  useDashboardStore,
  useTaskStore,
} from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "../v3/AgentNodeAssignmentFields";
import {
  archiveRecurringJob,
  createRecurringJob,
  listRecurringJobRuns,
  listRecurringJobs,
  previewRecurringSchedule,
  runRecurringJob,
  updateRecurringJob,
  type RecurringJob,
  type RecurringJobRun,
  type RecurringJobWrite,
} from "../lib/recurring-jobs";
import { HttpResponseError } from "../lib/http-response-error";
import {
  defaultRecurringSchedule,
  recurringScheduleExpressions,
  recurringScheduleFromExpressions,
  type RecurringScheduleDraft,
} from "../lib/recurring-schedule";
import { RecurringScheduleEditor } from "./RecurringScheduleEditor";

type Editor = {
  name: string;
  prompt: string;
  timezone: string;
  schedule: RecurringScheduleDraft;
  nodeId: string;
  agentId: string;
  modelPreset: string;
  folderId: string;
  containerKind: "folder" | "task";
  containerId: string;
  lateRunWindowSeconds: string;
  enabled: boolean;
};

const emptyEditor = (): Editor => ({
  name: "",
  prompt: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
  schedule: defaultRecurringSchedule(),
  nodeId: "",
  agentId: "",
  modelPreset: "",
  folderId: "",
  containerKind: "folder",
  containerId: "",
  lateRunWindowSeconds: "1800",
  enabled: true,
});

export function RecurringJobsTab() {
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const catalog = useDashboardStore((state) => state.catalog);
  const taskOverview = useTaskStore((state) => state.overview.snapshot);
  const loadTaskOverview = useTaskStore((state) => state.loadOverview);
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [selected, setSelected] = useState<RecurringJob | null>(null);
  const [editor, setEditor] = useState<Editor>(emptyEditor);
  const [runs, setRuns] = useState<RecurringJobRun[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (jobId: string) => {
    const loaded = await listRecurringJobRuns(jobId);
    setRuns(loaded);
  }, []);

  const refresh = useCallback(async (
    selectId?: string | null,
    options: { preserveEditor?: boolean } = {},
  ) => {
    const loaded = await listRecurringJobs(true);
    setJobs(loaded);
    if (selectId) {
      const next = loaded.find((job) => job.job_id === selectId) ?? null;
      setSelected(next);
      if (next) {
        if (!options.preserveEditor) setEditor(editorFromJob(next));
        await loadRuns(next.job_id);
      } else setRuns([]);
    }
  }, [loadRuns]);

  useEffect(() => {
    void refresh().catch((caught: unknown) => setError(message(caught)));
  }, [refresh]);

  useEffect(() => {
    if (editor.containerKind !== "task") return;
    void loadTaskOverview().catch((caught: unknown) => setError(message(caught)));
  }, [editor.containerKind, loadTaskOverview]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const write = writeFromEditor(editor);
      const saved = selected
        ? await updateRecurringJob(selected.job_id, { ...write, expected_version: selected.version })
        : await createRecurringJob({ ...write, idempotency_key: `recurring-job:${crypto.randomUUID()}` });
      await refresh(saved.job_id);
    } catch (caught) {
      if (isVersionConflict(caught) && selected) {
        try {
          await refresh(selected.job_id, { preserveEditor: true });
          setError("다른 변경을 반영했습니다. 입력은 보존했습니다. 최신 버전으로 다시 저장하세요.");
        } catch (reloadError) {
          setError(message(reloadError));
        }
      } else setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateRecurringJob(selected.job_id, {
        expected_version: selected.version,
        enabled,
      });
      await refresh(saved.job_id);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!selected || !window.confirm(`“${selected.name}” 작업을 보관할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      await archiveRecurringJob(selected.job_id, selected.version);
      setSelected(null);
      setEditor(emptyEditor());
      setPreview([]);
      await refresh();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const run = await runRecurringJob(selected.job_id, `recurring-run:${crypto.randomUUID()}`);
      setRuns((current) => [run, ...current.filter((item) => item.run_id !== run.run_id)]);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const previewSchedule = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await previewRecurringSchedule({
        timezone: editor.timezone,
        schedule_expressions: recurringScheduleExpressions(editor.schedule),
      });
      setPreview(result.nextRuns);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const activeJobs = useMemo(() => jobs.filter((job) => job.archived_at === null), [jobs]);
  const archivedJobs = useMemo(() => jobs.filter((job) => job.archived_at !== null), [jobs]);

  return (
    <section data-testid="recurring-jobs-tab" className="grid min-h-0 gap-4 lg:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.6fr)]">
      <aside className="min-h-0 rounded border border-border bg-muted/20 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">반복 작업</h3>
            <p className="text-xs text-muted-foreground">서버가 다음 실행을 계산합니다.</p>
          </div>
          <div className="flex gap-2"><Button type="button" size="sm" variant="outline" data-testid="recurring-jobs-refresh" onClick={() => void refresh(selected?.job_id, { preserveEditor: true }).catch((caught: unknown) => setError(message(caught)))}>새로고침</Button><Button type="button" size="sm" variant="outline" onClick={() => {
            setSelected(null); setEditor(emptyEditor()); setRuns([]); setPreview([]); setError(null);
          }}>새 작업</Button></div>
        </div>
        <JobList
          title="활성"
          jobs={activeJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); void loadRuns(job.job_id).catch((caught: unknown) => setError(message(caught))); }}
        />
        {archivedJobs.length > 0 ? <JobList
          title="보관됨"
          jobs={archivedJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); void loadRuns(job.job_id).catch((caught: unknown) => setError(message(caught))); }}
        /> : null}
      </aside>

      <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{selected ? selected.name : "새 반복 작업"}</h3>
            {selected ? <p className="text-xs text-muted-foreground">다음 실행: {displayTime(selected.next_run_at)}</p> : null}
          </div>
          {selected ? <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy || selected.archived_at !== null} onClick={() => void runNow()}>지금 실행</Button>
            {selected.archived_at === null ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void setEnabled(!selected.enabled)}>{selected.enabled ? "일시정지" : "재개"}</Button> : null}
            <Button type="button" size="sm" variant="outline" disabled={busy || selected.archived_at !== null} onClick={() => void archive()}>보관</Button>
          </div> : null}
        </header>

        {error ? <div role="alert" className="rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">{error}</div> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="작업 이름"><input aria-label="작업 이름" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
          <Field label="시간대"><input aria-label="시간대" value={editor.timezone} onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} placeholder="Asia/Seoul" /></Field>
          <Field label="오프라인 허용 초"><input aria-label="오프라인 허용 초" type="number" min="1" value={editor.lateRunWindowSeconds} onChange={(event) => setEditor({ ...editor, lateRunWindowSeconds: event.target.value })} /></Field>
        </div>
        <RecurringScheduleEditor value={editor.schedule} onChange={(schedule) => setEditor((current) => ({ ...current, schedule }))} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} />생성·저장 후 자동 실행</label>
        <Field label="작업 내용"><textarea aria-label="작업 내용" rows={5} value={editor.prompt} onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} /></Field>

        <div className="rounded border border-border p-3">
          <p className="mb-2 text-sm font-medium">실행 대상</p>
          <AgentNodeAssignmentFields
            agentId={editor.agentId}
            nodeId={editor.nodeId}
            modelPreset={editor.modelPreset}
            presentation="session"
            onAgentIdChange={(agentId) => setEditor((current) => ({ ...current, agentId }))}
            onNodeIdChange={(nodeId) => setEditor((current) => ({ ...current, nodeId }))}
            onModelPresetChange={(modelPreset) => setEditor((current) => ({ ...current, modelPreset }))}
            onError={(next) => setError(next)}
          />
        </div>

        <div className="grid gap-3 rounded border border-border p-3 sm:grid-cols-2">
          <NewSessionFolderSelector
            folders={catalog?.folders ?? []}
            selectedFolderId={editor.folderId || null}
            onFolderChange={(folderId) => setEditor((current) => ({
              ...current,
              folderId: folderId ?? "",
              containerId: current.containerKind === "folder" ? folderId ?? "" : "",
            }))}
            label="결과 폴더"
            placeholder="폴더를 선택하세요"
          />
          <Field label="결과 위치"><select value={editor.containerKind} onChange={(event) => setEditor((current) => ({
            ...current,
            containerKind: event.target.value as Editor["containerKind"],
            containerId: event.target.value === "folder" ? current.folderId : "",
          }))}><option value="folder">선택한 폴더</option><option value="task">기존 업무</option></select></Field>
          {editor.containerKind === "task" ? <TaskTargetSelector
            selectedTaskId={editor.containerId}
            tasks={(taskOverview?.tasks ?? []).filter((task) => task.folder_id === editor.folderId)}
            onChange={(containerId) => setEditor((current) => ({ ...current, containerId }))}
          /> : <p className="text-sm text-muted-foreground">선택한 폴더에 결과 세션을 저장합니다.</p>}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void previewSchedule()}>다음 5회 보기</Button>
          <Button type="button" size="sm" disabled={busy || selected?.archived_at != null} onClick={() => void save()}>{busy ? "저장 중..." : selected ? "변경 저장" : "반복 작업 생성"}</Button>
        </div>
        {preview.length > 0 ? <div className="rounded border border-border bg-muted/20 p-3 text-sm"><p className="mb-1 font-medium">다음 5회</p><ol className="list-decimal space-y-1 pl-5">{preview.map((time) => <li key={time}>{displayTime(time)}</li>)}</ol></div> : null}

        {selected ? <RunHistory runs={runs} onOpenSession={setActiveSession} /> : null}
      </div>
    </section>
  );
}

function JobList({ title, jobs, selectedId, onSelect }: { title: string; jobs: RecurringJob[]; selectedId: string | null; onSelect(job: RecurringJob): void }) {
  return <div className="mb-4"><p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p><div className="space-y-1">{jobs.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">없음</p> : jobs.map((job) => <button key={job.job_id} type="button" className={`w-full rounded px-2 py-2 text-left text-sm ${selectedId === job.job_id ? "bg-accent-blue/15 text-foreground" : "hover:bg-muted"}`} onClick={() => onSelect(job)}><span className="block truncate font-medium">{job.name}</span><span className="block truncate text-xs text-muted-foreground">{job.enabled ? displayTime(job.next_run_at) : job.archived_at ? "보관됨" : "일시정지"}</span></button>)}</div></div>;
}

function TaskTargetSelector({
  selectedTaskId,
  tasks,
  onChange,
}: {
  selectedTaskId: string;
  tasks: Array<{ task_id: string; task_title: string }>;
  onChange(taskId: string): void;
}) {
  const selected = tasks.find((task) => task.task_id === selectedTaskId);
  return <div className="grid gap-1 text-sm"><span className="text-muted-foreground">결과 업무</span>{tasks.length === 0 ? <p className="text-sm text-muted-foreground">선택한 폴더의 업무를 불러오는 중이거나 업무가 없습니다.</p> : <Select value={selectedTaskId} onValueChange={(taskId) => onChange(taskId ?? "")}><SelectTrigger><span className={selected ? "" : "text-muted-foreground"}>{selected?.task_title ?? "업무를 선택하세요"}</span></SelectTrigger><SelectPopup>{tasks.map((task) => <SelectItem key={task.task_id} value={task.task_id}>{task.task_title}</SelectItem>)}</SelectPopup></Select>}</div>;
}

function RunHistory({ runs, onOpenSession }: { runs: RecurringJobRun[]; onOpenSession(sessionId: string): void }) {
  return <section className="rounded border border-border p-3"><h4 className="mb-2 text-sm font-medium">최근 실행</h4>{runs.length === 0 ? <p className="text-sm text-muted-foreground">아직 실행 이력이 없습니다.</p> : <ul className="space-y-2">{runs.map((run) => <li key={run.run_id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 text-sm last:border-0 last:pb-0"><div><span className="font-medium">{run.state}</span><span className="ml-2 text-xs text-muted-foreground">{displayTime(run.scheduled_for ?? run.created_at)}</span>{run.reason_message ? <p className="mt-1 text-xs text-muted-foreground">{run.reason_message}</p> : null}</div><Button type="button" size="sm" variant="outline" onClick={() => onOpenSession(run.session_id)}>세션 열기</Button></li>)}</ul>}</section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1 text-sm"><span className="text-muted-foreground">{label}</span>{children}</label>;
}

function editorFromJob(job: RecurringJob): Editor {
  return {
    name: job.name,
    prompt: job.prompt,
    timezone: job.timezone,
    schedule: recurringScheduleFromExpressions(job.schedule_expressions),
    nodeId: job.node_id,
    agentId: job.agent_id,
    modelPreset: job.model_preset ?? "",
    folderId: job.folder_id,
    containerKind: job.container.kind,
    containerId: job.container.id,
    lateRunWindowSeconds: String(job.late_run_window_seconds),
    enabled: job.enabled,
  };
}

function writeFromEditor(editor: Editor): RecurringJobWrite {
  const lateRunWindowSeconds = Number(editor.lateRunWindowSeconds);
  if (!Number.isSafeInteger(lateRunWindowSeconds) || lateRunWindowSeconds < 1) throw new Error("오프라인 허용 초는 1 이상의 정수여야 합니다.");
  return {
    name: editor.name.trim(),
    prompt: editor.prompt.trim(),
    timezone: editor.timezone.trim(),
    schedule_expressions: recurringScheduleExpressions(editor.schedule),
    node_id: editor.nodeId.trim(),
    agent_id: editor.agentId.trim(),
    model_preset: editor.modelPreset.trim() || null,
    container: { kind: editor.containerKind, id: editor.containerId.trim() },
    folder_id: editor.folderId.trim(),
    late_run_window_seconds: lateRunWindowSeconds,
    enabled: editor.enabled,
  };
}

function displayTime(value: string | null): string { return value ? new Date(value).toLocaleString() : "없음"; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function isVersionConflict(value: unknown): value is HttpResponseError { return value instanceof HttpResponseError && value.status === 409; }
