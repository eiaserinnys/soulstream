import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { createI18n } from "@soulstream/i18n";
import {
  Button,
  FrameLoading,
  Input,
  NewSessionFolderSelector,
  useDashboardStore,
} from "@seosoyoung/soul-ui";

import { AgentNodeAssignmentFields } from "../v3/AgentNodeAssignmentFields";
import {
  archiveRecurringJob,
  createRecurringJob,
  listRecurringJobRuns,
  listRecurringJobs,
  previewRecurringSchedule,
  recurringJobConditionText,
  RecurringJobRequestError,
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
import { busyButtonClassName } from "./config/busy-button";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroupBox,
  SettingsListDetailFrame,
  SettingsListHeader,
  SettingsListRow,
  SettingsListSection,
  SettingsMultilineField,
} from "./config/SettingsListDetail";

type Translate = ReturnType<typeof useTranslation>["t"];

type Editor = {
  name: string;
  prompt: string;
  timezone: string;
  schedule: RecurringScheduleDraft;
  nodeId: string;
  agentId: string;
  modelPreset: string;
  folderId: string;
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
  lateRunWindowSeconds: "1800",
  enabled: true,
});

export const recurringJobsApi = { archiveRecurringJob, createRecurringJob, listRecurringJobRuns, listRecurringJobs, previewRecurringSchedule, runRecurringJob, updateRecurringJob };

export function RecurringJobsTab({ api = recurringJobsApi, assignment }: { api?: typeof recurringJobsApi; assignment?: import("../v3/AgentNodeAssignmentFields").AssignmentData } = {}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const setActiveSession = useDashboardStore((state) => state.setActiveSession);
  const catalog = useDashboardStore((state) => state.catalog);
  const [jobs, setJobs] = useState<RecurringJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<RecurringJob | null>(null);
  const [editor, setEditor] = useState<Editor>(emptyEditor);
  const [runs, setRuns] = useState<RecurringJobRun[]>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const pendingCreateFocus = useRef<{ jobId: string; button: HTMLButtonElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string; key: number } | null>(null);
  const actionErrorKey = useRef(0);
  const failAction = (text: string) => setActionError({ message: text, key: ++actionErrorKey.current });
  const [listFailed, setListFailed] = useState(false);

  const loadRuns = useCallback(async (jobId: string) => {
    const loaded = await api.listRecurringJobRuns(jobId);
    setRuns(loaded);
  }, [api]);

  const refresh = useCallback(async (
    selectId?: string | null,
    options: { preserveEditor?: boolean } = {},
  ) => {
    let loaded: RecurringJob[];
    try {
      loaded = await api.listRecurringJobs(true);
      setListFailed(false);
      setLoaded(true);
    } catch (caught) {
      setListFailed(true);
      throw caught;
    }
    setJobs(loaded);
    if (selectId) {
      const next = loaded.find((job) => job.job_id === selectId) ?? null;
      setSelected(next);
      if (next) {
        if (!options.preserveEditor) setEditor(editorFromJob(next));
        await loadRuns(next.job_id);
      } else {
        setEditor(emptyEditor());
        setRuns([]);
        setPreview([]);
      }
    }
  }, [loadRuns]);

  useEffect(() => {
    void refresh().catch((caught: unknown) => setError(message(caught, t)));
  }, [refresh, t]);

  useLayoutEffect(() => {
    const pending = pendingCreateFocus.current;
    if (!pending || selected?.job_id !== pending.jobId) return;
    pendingCreateFocus.current = null;
    if (!pending.button.isConnected && document.activeElement === document.body) saveButtonRef.current?.focus();
  }, [selected]);

  const save = async (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    const createButton = !selected && event.detail === 0 && event.currentTarget.matches(":focus-visible") ? event.currentTarget : null;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const write = writeFromEditor(t, editor, selected?.schedule_kind);
      const saved = selected
        ? await api.updateRecurringJob(selected.job_id, { ...write, expected_version: selected.version })
        : await api.createRecurringJob({ ...write, idempotency_key: `recurring-job:${crypto.randomUUID()}` });
      if (createButton) pendingCreateFocus.current = { jobId: saved.job_id, button: createButton };
      await refresh(saved.job_id).catch((caught: unknown) => {
        pendingCreateFocus.current = null;
        setError(message(caught, t));
      });
    } catch (caught) {
      if (isVersionConflict(caught) && selected) {
        try {
          await refresh(selected.job_id, { preserveEditor: true });
          failAction(t("jobs.recurring.conflict"));
        } catch (reloadError) {
          setError(message(reloadError, t));
        }
      } else failAction(message(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (busy) return;
    if (!selected) return;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const saved = await api.updateRecurringJob(selected.job_id, {
        expected_version: selected.version,
        enabled,
      });
      await refresh(saved.job_id);
    } catch (caught) {
      setError(message(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (busy) return;
    if (!selected || !confirmRecurringArchive(selected.name, t)) return;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      await api.archiveRecurringJob(selected.job_id, selected.version);
      setSelected(null);
      setEditor(emptyEditor());
      setPreview([]);
      await refresh();
    } catch (caught) {
      setError(message(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (busy) return;
    if (!selected) return;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const jobId = selected.job_id;
      const run = await api.runRecurringJob(jobId, `recurring-run:${crypto.randomUUID()}`);
      if (selected.schedule_kind === "once" || selected.schedule_kind === "event") {
        await refresh(jobId);
      } else {
        setRuns((current) => [run, ...current.filter((item) => item.run_id !== run.run_id)]);
      }
    } catch (caught) {
      setError(message(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const previewSchedule = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      const result = await api.previewRecurringSchedule({
        timezone: editor.timezone,
        schedule_expressions: recurringScheduleExpressions(editor.schedule),
      });
      setPreview(result.nextRuns);
    } catch (caught) {
      failAction(message(caught, t));
    } finally {
      setBusy(false);
    }
  };

  const activeJobs = useMemo(() => jobs.filter((job) => job.archived_at === null), [jobs]);
  const archivedJobs = useMemo(() => jobs.filter((job) => job.archived_at !== null), [jobs]);

  return (
    <SettingsListDetailFrame testId="recurring-jobs-tab" list={<>
        <SettingsListHeader title={t("jobs.recurring.title")} description={t("jobs.recurring.description")} actions={<><Button type="button" size="sm" variant="outline" data-testid="recurring-jobs-refresh" onClick={() => { setError(null); setActionError(null); void refresh(selected?.job_id, { preserveEditor: true }).catch((caught: unknown) => setError(message(caught, t))); }}>{t("jobs.common.refresh")}</Button><Button type="button" size="sm" variant="outline" onClick={() => {
            setSelected(null); setEditor(emptyEditor()); setRuns([]); setPreview([]); setError(null); setActionError(null);
          }}>{t("jobs.recurring.newJob")}</Button></>} />
        {!listFailed && loaded ? <><JobList
          title={t("jobs.recurring.active")}
          jobs={activeJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); setActionError(null); void loadRuns(job.job_id).catch((caught: unknown) => setError(message(caught, t))); }}
        />
        {archivedJobs.length > 0 ? <JobList
          title={t("jobs.recurring.archived")}
          jobs={archivedJobs}
          selectedId={selected?.job_id ?? null}
          onSelect={(job) => { setSelected(job); setEditor(editorFromJob(job)); setPreview([]); setError(null); setActionError(null); void loadRuns(job.job_id).catch((caught: unknown) => setError(message(caught, t))); }}
        /> : null}</> : !listFailed ? <FrameLoading inline label={t("jobs.common.loading")} /> : null}
    </>}>
        <SettingsDetailHeader selectableTitle={Boolean(selected)}
          title={selected ? selected.name : t("jobs.recurring.newRecurringJob")}
          subtitle={selected ? t("jobs.recurring.nextRun", { time: displayTime(selected.next_run_at, locale, t) }) : null}
          actions={selected ? <>
            <Button type="button" size="sm" variant="outline" className={busyButtonClassName} aria-disabled={busy} disabled={selected.archived_at !== null} onClick={() => void runNow()}>{t("jobs.recurring.runNow")}</Button>
            {selected.archived_at === null ? <Button type="button" size="sm" variant="outline" className={busyButtonClassName} aria-disabled={busy} onClick={() => void setEnabled(!selected.enabled)}>{selected.enabled ? t("jobs.recurring.pause") : t("jobs.recurring.resume")}</Button> : null}
            <Button type="button" size="sm" variant="outline" className={busyButtonClassName} aria-disabled={busy} disabled={selected.archived_at !== null} onClick={() => void archive()}>{t("jobs.recurring.archive")}</Button>
          </> : null}
        />

        {error ? <SettingsAlert><span data-v3-selectable-content="true">{error}</span></SettingsAlert> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsField label={t("jobs.recurring.name")}><Input className="min-w-0" aria-label={t("jobs.recurring.name")} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></SettingsField>
          {editor.schedule.mode !== "once" ? <SettingsField label={t("jobs.recurring.timeZone")}><Input className="min-w-0" aria-label={t("jobs.recurring.timeZone")} value={editor.timezone} onChange={(event) => setEditor({ ...editor, timezone: event.target.value })} placeholder="Asia/Seoul" /></SettingsField> : null}
          <SettingsField label={t("jobs.recurring.offlineGrace")}><Input className="min-w-0" aria-label={t("jobs.recurring.offlineGrace")} type="number" min="1" value={editor.lateRunWindowSeconds} onChange={(event) => setEditor({ ...editor, lateRunWindowSeconds: event.target.value })} /></SettingsField>
        </div>
        {selected?.schedule_kind === "event"
          ? <div className="rounded-floor border border-border p-3 text-sm" data-testid="recurring-event-condition" data-v3-selectable-content="true">{recurringJobConditionText(selected, t)}</div>
          : <RecurringScheduleEditor value={editor.schedule} scheduleKind={selected?.schedule_kind} onChange={(schedule) => setEditor((current) => ({ ...current, schedule }))} />}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} />{t("jobs.recurring.enableAfterSave")}</label>
        <SettingsMultilineField label={t("jobs.recurring.prompt")} value={editor.prompt} onChange={(prompt) => setEditor({ ...editor, prompt })} />

        <SettingsGroupBox title={t("jobs.common.executionTarget")}>
          <AgentNodeAssignmentFields data={assignment}
            agentId={editor.agentId}
            nodeId={editor.nodeId}
            modelPreset={editor.modelPreset}
            presentation="session"
            onAgentIdChange={(agentId) => setEditor((current) => ({ ...current, agentId }))}
            onNodeIdChange={(nodeId) => setEditor((current) => ({ ...current, nodeId }))}
            onModelPresetChange={(modelPreset) => setEditor((current) => ({ ...current, modelPreset }))}
            onError={(next) => setError(next)}
          />
        </SettingsGroupBox>

        <div className="grid gap-3 rounded-floor border border-border p-3 sm:grid-cols-2">
          <NewSessionFolderSelector
            folders={catalog?.folders ?? []}
            selectedFolderId={editor.folderId || null}
            onFolderChange={(folderId) => setEditor((current) => ({
              ...current,
              folderId: folderId ?? "",
            }))}
            label={t("jobs.recurring.resultFolder")}
            placeholder={t("jobs.common.selectFolder")}
          />
          <p className="text-sm text-muted-foreground">{t("jobs.recurring.resultFolderHelp")}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {editor.schedule.mode !== "once" && selected?.schedule_kind !== "event" ? <Button type="button" size="sm" variant="outline" className={busyButtonClassName} aria-disabled={busy} onClick={() => void previewSchedule()}>{t("jobs.recurring.preview")}</Button> : null}
          <Button ref={saveButtonRef} type="button" size="sm" className={busyButtonClassName} aria-disabled={busy} disabled={selected?.archived_at != null} onClick={(event) => void save(event)}>{busy ? t("jobs.common.savingLegacy") : selected ? t("jobs.common.saveChanges") : editor.schedule.mode === "once" ? t("jobs.recurring.createOnce") : t("jobs.recurring.createRecurring")}</Button>
        </div>
        {actionError ? <SettingsAlert key={actionError.key} scrollIntoView><span data-v3-selectable-content="true">{actionError.message}</span></SettingsAlert> : null}
        {editor.schedule.mode !== "once" && selected?.schedule_kind !== "event" && preview.length > 0 ? <div className="rounded-floor border border-border bg-muted/20 p-3 text-sm"><p className="mb-1 font-medium">{t("jobs.recurring.nextFive")}</p><ol className="list-decimal space-y-1 pl-5">{preview.map((time) => <li key={time} data-v3-selectable-content="true">{displayTime(time, locale, t)}</li>)}</ol></div> : null}

        {selected ? <RunHistory runs={runs} onOpenSession={setActiveSession} /> : null}
    </SettingsListDetailFrame>
  );
}

function JobList({ title, jobs, selectedId, onSelect }: { title: string; jobs: RecurringJob[]; selectedId: string | null; onSelect(job: RecurringJob): void }) {
  const { t, i18n } = useTranslation();
  return <SettingsListSection emptyText={t("jobs.common.none")} title={title} isEmpty={jobs.length === 0}>{jobs.map((job) => <SettingsListRow key={job.job_id} title={job.name} meta={jobMeta(job, i18n.resolvedLanguage, t)} selected={selectedId === job.job_id} onSelect={() => onSelect(job)} />)}</SettingsListSection>;
}

function RunHistory({ runs, onOpenSession }: { runs: RecurringJobRun[]; onOpenSession(sessionId: string): void }) {
  const { t, i18n } = useTranslation();
  return <section className="rounded-floor border border-border p-3"><h4 className="mb-2 text-sm font-medium">{t("jobs.recurring.recentRuns")}</h4>{runs.length === 0 ? <p className="text-sm text-muted-foreground">{t("jobs.recurring.noRuns")}</p> : <ul className="space-y-2">{runs.map((run) => {
    const action = sessionAction(run, t);
    return <li key={run.run_id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 text-sm last:border-0 last:pb-0"><div><span className="font-medium" data-v3-selectable-content="true">{run.state}</span><span className="ml-2 text-xs text-muted-foreground" data-v3-selectable-content="true">{displayTime(run.scheduled_for ?? run.created_at, i18n.resolvedLanguage, t)}</span>{run.reason_message || action.message ? <p className="mt-1 text-xs text-muted-foreground" data-v3-selectable-content="true">{run.reason_message ?? action.message}</p> : null}</div><Button type="button" size="sm" variant="outline" disabled={!action.canOpen} onClick={() => onOpenSession(run.session_id)}>{action.label}</Button></li>;
  })}</ul>}</section>;
}

function sessionAction(run: RecurringJobRun, t: Translate): { label: string; canOpen: boolean; message: string | null } {
  const noSessionState = new Set(["queued", "waiting_for_node", "skipped_overlap", "skipped_late", "cancelled"]);
  const noSessionError = run.state === "error" && (
    run.reason_code === "RUN_SNAPSHOT_INVALID" ||
    run.reason_code === "SESSION_DELETED" ||
    run.reason_code === "CREATE_SESSION_BEFORE_SEND_FAILED"
  );
  if (noSessionState.has(run.state) || noSessionError) {
    return { label: t("jobs.recurring.noSession"), canOpen: false, message: t("jobs.recurring.noSessionHelp") };
  }
  if (
    run.state === "dispatching" ||
    run.state === "awaiting_session" ||
    run.reason_code === "CREATE_SESSION_REJECTED"
  ) {
    return { label: t("jobs.recurring.openFixedSession"), canOpen: true, message: null };
  }
  return { label: t("jobs.recurring.openSession"), canOpen: true, message: null };
}

function editorFromJob(job: RecurringJob): Editor {
  return {
    name: job.name,
    prompt: job.prompt,
    timezone: job.timezone,
    schedule: job.schedule_kind === "once"
      ? { ...defaultRecurringSchedule(), mode: "once", runAtLocal: job.run_at ? toLocalDateTime(job.run_at) : defaultRecurringSchedule().runAtLocal }
      : recurringScheduleFromExpressions(job.schedule_expressions),
    nodeId: job.node_id,
    agentId: job.agent_id,
    modelPreset: job.model_preset ?? "",
    folderId: job.folderId,
    lateRunWindowSeconds: String(job.late_run_window_seconds),
    enabled: job.enabled,
  };
}

function jobMeta(job: RecurringJob, locale: string | undefined, t: Translate): string {
  if (job.archived_at) return t("jobs.recurring.archived");
  if (!job.enabled) return t("jobs.recurring.paused");
  if (job.schedule_kind === "event") return recurringJobConditionText(job, t);
  if (job.schedule_kind === "once") return t("jobs.recurring.onceAt", { time: displayTime(job.next_run_at ?? job.run_at, locale, t) });
  return displayTime(job.next_run_at, locale, t);
}

function writeFromEditor(t: Translate, editor: Editor, scheduleKind?: RecurringJob["schedule_kind"]): RecurringJobWrite {
  const lateRunWindowSeconds = Number(editor.lateRunWindowSeconds);
  if (!Number.isSafeInteger(lateRunWindowSeconds) || lateRunWindowSeconds < 1) throw new Error(t("jobs.recurring.invalidOfflineGrace"));
  const common = {
    name: editor.name.trim(),
    prompt: editor.prompt.trim(),
    timezone: editor.schedule.mode === "once"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : editor.timezone.trim(),
    node_id: editor.nodeId.trim(),
    agent_id: editor.agentId.trim(),
    model_preset: editor.modelPreset.trim() || null,
    folderId: editor.folderId.trim(),
    late_run_window_seconds: lateRunWindowSeconds,
    enabled: editor.enabled,
  };
  if (scheduleKind === "event") return common;
  if (editor.schedule.mode === "once") {
    const runAt = new Date(editor.schedule.runAtLocal);
    if (!editor.schedule.runAtLocal || !Number.isFinite(runAt.getTime())) throw new Error(t("jobs.recurring.missingRunAt"));
    return { ...common, run_at: runAt.toISOString() };
  }
  return { ...common, schedule_expressions: recurringScheduleExpressions(editor.schedule) };
}

function displayTime(value: string | null, locale: string | undefined, t: Translate): string {
  return value ? new Date(value).toLocaleString(locale) : t("jobs.common.none");
}
function toLocalDateTime(value: string): string {
  const date = new Date(value);
  const parts = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")];
  return `${String(parts[0]).padStart(4, "0")}-${parts[1]}-${parts[2]}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function message(value: unknown, t: Translate): string {
  if (value instanceof RecurringJobRequestError) return t("jobs.recurring.requestFailed", { status: value.status });
  return value instanceof Error ? value.message : String(value);
}
function isVersionConflict(value: unknown): value is HttpResponseError { return value instanceof HttpResponseError && value.status === 409; }

export function confirmRecurringArchive(name: string, t: Translate = createI18n("ko").t) {
  return window.confirm(t("jobs.recurring.confirmArchive", { name }));
}
