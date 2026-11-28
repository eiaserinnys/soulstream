import { useTranslation } from "react-i18next";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, FrameLoading } from "@seosoyoung/soul-ui";
import type { NodeGitCloneJob, NodeGitRepoSummary } from "../../../../packages/wire-schema/generated/typescript/index";
import {
  getNodeGitClone,
  nodeGitErrorText,
  nodeGitRequestDetail,
  nodeGitRequestErrorOf,
  startNodeGitClone,
  type NodeGitRequestError,
} from "../../lib/node-git-api";
import { V3ErrorNotice } from "../../v3/V3ErrorNotice";
import { busyButtonClassName } from "../config/busy-button";
import { SettingFieldWidget } from "../config/SettingFieldWidget";
import { SettingsAlert, SettingsGroupBox } from "../config/SettingsListDetail";
import { gitTextField } from "./git-field";
import type { NodeGitSectionProps } from "./NodeGitPanel";

const CLONE_POLL_MS = 2000;

export function GitRepositoriesSection(props: NodeGitSectionProps & { onReload(): void }) {
  const { t } = useTranslation();
  const { projects } = props.snapshot;
  return <SettingsGroupBox title={t("accounts.git.projectRepos")}>
    {projects.state === "root_unset"
      ? <p className="text-sm text-muted-foreground">{t("accounts.git.noRootConfig")}</p>
      : projects.state === "root_missing"
        ? <SettingsAlert>{t("accounts.git.noRoot", { path: projects.root })}</SettingsAlert>
        : <ReadyProjects {...props} root={projects.root ?? ""} repos={projects.repos} />}
  </SettingsGroupBox>;
}

function RepoRow({ repo }: { repo: NodeGitRepoSummary }) {
  const { t } = useTranslation();
  return <li className="min-w-0">
    <div className="flex min-w-0 items-center gap-2">
      <span data-v3-selectable-content="true" title={repo.name} className="min-w-0 flex-1 truncate text-sm font-medium">{repo.name}</span>
      {repo.branch ? <span data-v3-selectable-content="true" title={repo.branch} className="max-w-1/2 shrink-0 truncate text-xs text-muted-foreground">{repo.branch}</span> : null}
      {repo.dirty ? <Badge variant="warning" size="sm">{t("accounts.git.dirty")}</Badge> : null}
    </div>
    {repo.origin_url ? <p data-v3-selectable-content="true" title={repo.origin_url} className="truncate text-xs text-muted-foreground">{repo.origin_url}</p> : null}
  </li>;
}

function cloneFailureText(job: NodeGitCloneJob, t: ReturnType<typeof useTranslation>["t"]): string {
  const base = nodeGitErrorText({ code: job.error?.code ?? "clone_failed" }, t);
  return job.error?.code === "auth_failed" && job.url.startsWith("https://") ? `${base} ${t("accounts.git.privateHint")}` : base;
}

function ReadyProjects({ nodeId, request, snapshot, onSnapshot, onReload, root, repos }: NodeGitSectionProps & { onReload(): void; root: string; repos: NodeGitRepoSummary[] }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<NodeGitRequestError | null>(null);
  const runningCloneId = snapshot.clone?.state === "running" ? snapshot.clone.clone_id : null;
  const [cloneId, setCloneId] = useState<string | null>(runningCloneId);
  if (cloneId === null && runningCloneId !== null) setCloneId(runningCloneId);

  const poll = useQuery({
    queryKey: ["node-git-clone", nodeId, cloneId],
    enabled: cloneId !== null,
    queryFn: () => getNodeGitClone(request, nodeId, cloneId ?? ""),
    refetchInterval: (query) => query.state.status === "error" || query.state.data?.state === "done" || query.state.data?.state === "failed" ? false : CLONE_POLL_MS,
    retry: false,
  });
  const job = poll.data ?? null;
  const pollFailed = poll.isError && !poll.isFetching;
  const running = starting || (cloneId !== null && !pollFailed && (job === null || job.state === "running"));

  useEffect(() => {
    if (job?.state === "done") onReload();
  }, [job?.state, job?.clone_id]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (running) return;
    setStarting(true);
    setStartError(null);
    try {
      const started = await startNodeGitClone(request, nodeId, { url, ...(repoName.trim() ? { repo_name: repoName.trim() } : {}) });
      setCloneId(started.clone_id);
      onSnapshot({ ...snapshot, clone: started });
      setUrl("");
      setRepoName("");
    } catch (caught) {
      setStartError(nodeGitRequestErrorOf(caught));
    } finally {
      setStarting(false);
    }
  };

  const fieldError = (field: "url" | "repo_name") => startError?.field === field
    ? <p role="alert" data-v3-selectable-content="true" className="text-xs text-destructive-foreground">{nodeGitErrorText(startError, t)}</p>
    : null;

  return <div className="space-y-3">
    <p data-v3-selectable-content="true" className="break-all text-xs text-muted-foreground">{root}</p>
    <SettingsGroupBox>
      {repos.length === 0
        ? <p className="text-sm text-muted-foreground">{t("accounts.git.noRepos")}</p>
        : <ul className="space-y-2">{repos.map((repo) => <RepoRow key={repo.name} repo={repo} />)}</ul>}
    </SettingsGroupBox>
    <form className="space-y-4" onSubmit={(event) => { void start(event); }}>
      <SettingFieldWidget field={gitTextField("url", t("accounts.git.remoteUrl"))} value={url} onChange={setUrl} statusSlot={fieldError("url")} />
      <SettingFieldWidget field={gitTextField("repo_name", t("accounts.git.folderName"), t("accounts.git.folderPlaceholder"))} value={repoName} onChange={setRepoName} statusSlot={<div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" aria-disabled={running || undefined} className={busyButtonClassName}>{t("accounts.git.clone")}</Button>
        {running ? <FrameLoading inline label={t("accounts.git.cloning")} /> : null}
        {job?.state === "done" ? <span role="status" data-v3-selectable-content="true" className="min-w-0 break-all text-xs text-muted-foreground">{t("accounts.git.cloned", { name: job.repo_name })}</span> : null}
        {fieldError("repo_name")}
        {startError && !startError.field ? <p role="alert" data-v3-selectable-content="true" className="text-xs text-destructive-foreground">{nodeGitErrorText(startError, t)}</p> : null}
      </div>} />
    </form>
    {pollFailed ? <V3ErrorNotice message={t("accounts.git.pollError")} detail={poll.error && nodeGitRequestDetail(poll.error, t)} retryLabel={t("accounts.common.checkAgain")} onRetry={() => { void poll.refetch(); }} /> : null}
    {job?.state === "failed" ? <V3ErrorNotice message={cloneFailureText(job, t)} detail={job.error?.detail ?? null} /> : null}
  </div>;
}
