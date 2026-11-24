export type WorkspaceGitStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "typechange";
export interface WorkspaceGitFile {
  path: string; status: WorkspaceGitStatus; orig_path: string | null;
  added: number | null; deleted: number | null; size: number | null;
}
export interface WorkspaceGitSnapshot {
  branch: string | null; head: string | null; upstream: string | null;
  ahead: number; behind: number; truncated: boolean;
  files: WorkspaceGitFile[];
  commits: { sha: string; subject: string; committed_at: string; files: string[] }[];
}
export interface NodeWorkspaceSnapshot {
  root: string; state: "ready" | "pending" | "not_git"; observed_at: string | null;
  refreshing: boolean; git: WorkspaceGitSnapshot | null;
}
export interface SessionWorkspaceResponse {
  session_id: string; root: string | null;
  node: { id: string; status: "ok" | "offline" | "unsupported" | "no_workspace" | "error" };
  snapshot: ({ state: NodeWorkspaceSnapshot["state"]; observed_at: string | null; refreshing: boolean } &
    Pick<WorkspaceGitSnapshot, "branch" | "head" | "upstream" | "ahead" | "behind" | "truncated">) | null;
  attribution: "full" | "partial";
  // session_added, session_deleted: git_status가 null인 wrote 행에 세션 기록(편집 사건)에서 센 누적 줄 수다.
  // 내용 있는 편집이 없거나 git 변경이 있는 행이면 둘 다 null이고, 둘은 함께 null이거나 함께 수다.
  files: { path: string; git_status: WorkspaceGitStatus | null; orig_path: string | null; added: number | null; deleted: number | null; session_added: number | null; session_deleted: number | null; size: number | null; wrote: boolean; read: boolean; committed: boolean; last_activity_at: string | null }[];
  read_only: { path: string; size: number | null; last_read_at: string | null }[];
}

export interface SessionWorkspaceDiffResponse { path: string; status: WorkspaceGitStatus | "unchanged"; text: string; truncated: boolean; binary: boolean }
export interface SessionWorkspaceSessionDiffResponse {
  path: string;
  edits: { at: string; tool: string; kind: "edit" | "write" | "add" | "delete"; text: string; line_numbers: boolean; replace_all: boolean }[];
  unrecorded: number;
  truncated: boolean;
}
