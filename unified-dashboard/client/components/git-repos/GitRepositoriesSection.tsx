import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, FrameLoading } from "@seosoyoung/soul-ui";
import type { NodeGitCloneJob, NodeGitRepoSummary } from "../../../../packages/wire-schema/generated/typescript/index";
import {
  getNodeGitClone,
  nodeGitErrorText,
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
const URL_FIELD = gitTextField("url", "원격 주소");
const REPO_NAME_FIELD = gitTextField("repo_name", "폴더 이름", "비우면 주소의 이름");
const HTTPS_PRIVATE_HINT = "비공개 저장소는 SSH 주소(git@…)로 가져오세요.";

export function GitRepositoriesSection(props: NodeGitSectionProps & { onReload(): void }) {
  const { projects } = props.snapshot;
  return <SettingsGroupBox title="프로젝트 저장소">
    {projects.state === "root_unset"
      ? <p className="text-sm text-muted-foreground">저장소 폴더(WORKTREE_PROJECTS_ROOT)가 정해지지 않은 노드입니다.</p>
      : projects.state === "root_missing"
        ? <SettingsAlert>저장소 폴더가 없습니다: {projects.root}</SettingsAlert>
        : <ReadyProjects {...props} root={projects.root ?? ""} repos={projects.repos} />}
  </SettingsGroupBox>;
}

function RepoRow({ repo }: { repo: NodeGitRepoSummary }) {
  return <li className="min-w-0">
    <div className="flex min-w-0 items-center gap-2">
      <span data-v3-selectable-content="true" title={repo.name} className="min-w-0 flex-1 truncate text-sm font-medium">{repo.name}</span>
      {repo.branch ? <span data-v3-selectable-content="true" title={repo.branch} className="max-w-1/2 shrink-0 truncate text-xs text-muted-foreground">{repo.branch}</span> : null}
      {repo.dirty ? <Badge variant="warning" size="sm">변경 있음</Badge> : null}
    </div>
    {repo.origin_url ? <p data-v3-selectable-content="true" title={repo.origin_url} className="truncate text-xs text-muted-foreground">{repo.origin_url}</p> : null}
  </li>;
}

function cloneFailureText(job: NodeGitCloneJob): string {
  const base = nodeGitErrorText({ code: job.error?.code ?? "clone_failed" });
  return job.error?.code === "auth_failed" && job.url.startsWith("https://") ? `${base} ${HTTPS_PRIVATE_HINT}` : base;
}

function ReadyProjects({ nodeId, request, snapshot, onReload, root, repos }: NodeGitSectionProps & { onReload(): void; root: string; repos: NodeGitRepoSummary[] }) {
  const [url, setUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<NodeGitRequestError | null>(null);
  const [cloneId, setCloneId] = useState<string | null>(snapshot.clone?.state === "running" ? snapshot.clone.clone_id : null);

  const poll = useQuery({
    queryKey: ["node-git-clone", nodeId, cloneId],
    enabled: cloneId !== null,
    queryFn: () => getNodeGitClone(request, nodeId, cloneId ?? ""),
    refetchInterval: (query) => query.state.status === "error" || query.state.data?.state === "done" || query.state.data?.state === "failed" ? false : CLONE_POLL_MS,
    retry: false,
  });
  const job = poll.data ?? null;
  const running = starting || (cloneId !== null && !poll.isError && (job === null || job.state === "running"));

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
      setUrl("");
      setRepoName("");
    } catch (caught) {
      setStartError(nodeGitRequestErrorOf(caught));
    } finally {
      setStarting(false);
    }
  };

  const fieldError = (field: "url" | "repo_name") => startError?.field === field
    ? <p role="alert" data-v3-selectable-content="true" className="text-xs text-destructive-foreground">{nodeGitErrorText(startError)}</p>
    : null;

  return <div className="space-y-3">
    <p data-v3-selectable-content="true" className="break-all text-xs text-muted-foreground">{root}</p>
    <SettingsGroupBox>
      {repos.length === 0
        ? <p className="text-sm text-muted-foreground">저장소 없음</p>
        : <ul className="space-y-2">{repos.map((repo) => <RepoRow key={repo.name} repo={repo} />)}</ul>}
    </SettingsGroupBox>
    <form onSubmit={(event) => { void start(event); }}>
      <SettingFieldWidget field={URL_FIELD} value={url} onChange={setUrl} statusSlot={fieldError("url")} />
      <SettingFieldWidget field={REPO_NAME_FIELD} value={repoName} onChange={setRepoName} statusSlot={<div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" aria-disabled={running || undefined} className={busyButtonClassName}>가져오기</Button>
        {running ? <FrameLoading inline label="가져오는 중…" /> : null}
        {job?.state === "done" ? <span role="status" data-v3-selectable-content="true" className="min-w-0 break-all text-xs text-muted-foreground">가져왔습니다: {job.repo_name}</span> : null}
        {fieldError("repo_name")}
        {startError && !startError.field ? <p role="alert" data-v3-selectable-content="true" className="text-xs text-destructive-foreground">{nodeGitErrorText(startError)}</p> : null}
      </div>} />
    </form>
    {job?.state === "failed" ? <V3ErrorNotice message={cloneFailureText(job)} detail={job.error?.detail ?? null} /> : null}
  </div>;
}
