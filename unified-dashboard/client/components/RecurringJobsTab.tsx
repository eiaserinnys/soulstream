import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, useDashboardStore } from "@seosoyoung/soul-ui";

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

type Editor = {
  name: string;
  prompt: string;
  timezone: string;
  scheduleExpressions: string;
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
  scheduleExpressions: "0 9 * * 1-5",
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
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [selected, setSelected] = useState<RecurringJob | null>(null);
  const [editor, setEditor] = useState<Editor>(emptyEditor);
  const [runs, setRuns] = useState<RecurringJobRun[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (selectId?: string | null) => {
    const loaded = await listRecurringJobs(true);
    setJobs(loaded);
    if (selectId) {
      const next = loaded.find((job) => job.job_id === selectId) ?? null;
      setSelected(next);
      if (next) setEditor(editorFromJob(next));
    }
  }, []);

  useEffect(() => {
    void refresh().catch((caught: unknown) => setError(message(caught)));
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setRuns([]);
      return;
    }
    let active = true;
    void listRecurringJobRuns(selected.job_id)
      .then((loaded) => { if (active) setRuns(loaded); })
      .catch((caught: unknown) => { if (active) setError(message(caught)); });
    return () => { active = false; };
  }, [selected?.job_id]);

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
      setError(message(caught));
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
        schedule_expressions: splitScheduleExpressions(editor.scheduleExpressions),
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
          <Button type="button" size="sm" variant="outline" onClick={() => {
            setSelected(null); setEditor(emptyEditor()); setRuns([]); setPreview([]); setError(null);
          }}>새 작업</Button>
        </div>
        <JobList
          title="활성"
          jobs={activeJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); }}
        />
        {archivedJobs.length > 0 ? <JobList
          title="보관됨"
          jobs={archivedJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); }}
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
          <Field label="작업 이름"><input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
          <Field label="시간대"><input value={editor.timezone} onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} placeholder="Asia/Seoul" /></Field>
          <Field label="반복 cron"><input value={editor.scheduleExpressions} onChange={(event) => setEditor({ ...editor, scheduleExpressions: event.target.value })} placeholder="0 9,12 * * 1-5" /></Field>
          <Field label="오프라인 허용 초"><input type="number" min="1" value={editor.lateRunWindowSeconds} onChange={(event) => setEditor({ ...editor, lateRunWindowSeconds: event.target.value })} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">매일 `0 9 * * *` · 매주 월요일 `0 9 * * 1` · 매월 1일 `0 9 1 * *` · 고급 cron은 줄마다 5필드입니다.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} />생성·저장 후 자동 실행</label>
        <Field label="작업 내용"><textarea rows={5} value={editor.prompt} onChange={(event) => setEditor({ ...editor, prompt: event.target.value })} /></Field>

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

        <div className="grid gap-3 rounded border border-border p-3 sm:grid-cols-3">
          <Field label="결과 폴더 ID"><input value={editor.folderId} onChange={(event) => setEditor({ ...editor, folderId: event.target.value })} /></Field>
          <Field label="컨테이너 종류"><select value={editor.containerKind} onChange={(event) => setEditor({ ...editor, containerKind: event.target.value as Editor["containerKind"] })}><option value="folder">폴더</option><option value="task">업무</option></select></Field>
          <Field label="컨테이너 ID"><input value={editor.containerId} onChange={(event) => setEditor({ ...editor, containerId: event.target.value })} /></Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void previewSchedule()}>다음 5회 보기</Button>
          <Button type="button" size="sm" disabled={busy || selected?.archived_at !== null} onClick={() => void save()}>{busy ? "저장 중..." : selected ? "변경 저장" : "반복 작업 생성"}</Button>
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
    scheduleExpressions: job.schedule_expressions.join("\n"),
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
    schedule_expressions: splitScheduleExpressions(editor.scheduleExpressions),
    node_id: editor.nodeId.trim(),
    agent_id: editor.agentId.trim(),
    model_preset: editor.modelPreset.trim() || null,
    container: { kind: editor.containerKind, id: editor.containerId.trim() },
    folder_id: editor.folderId.trim(),
    late_run_window_seconds: lateRunWindowSeconds,
    enabled: editor.enabled,
  };
}

function splitScheduleExpressions(value: string): string[] {
  const expressions = value.split("\n").map((item) => item.trim()).filter(Boolean);
  if (expressions.length === 0) throw new Error("반복 cron을 하나 이상 입력해야 합니다.");
  return expressions;
}
function displayTime(value: string | null): string { return value ? new Date(value).toLocaleString() : "없음"; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
