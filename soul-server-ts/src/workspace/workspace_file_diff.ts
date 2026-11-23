import type { SessionWorkspaceDiffResponse, WorkspaceGitStatus } from "@soulstream/wire-schema/session-workspace";
import { GitProcessError, runBoundedProcess } from "../worktree/worktree_process.js";
import { validateWorkspacePath } from "./workspace_file_path.js";

const MAX_DIFF_BYTES = 512 * 1024;
export async function diffWorkspaceFile(root: string, file: string, origPath: string | null): Promise<Omit<SessionWorkspaceDiffResponse, "path">> {
  const current = await validateWorkspacePath(root, file, true);
  if (origPath) await validateWorkspacePath(root, origPath, true);
  const git = (args:string[], maxStdoutBytes?:number, acceptedExitCodes?:number[]) => runBoundedProcess({
    command:"git", args:["--no-optional-locks", "-c", "core.quotepath=false", ...args], cwd:root,
    timeoutMs:30_000, maxStdoutBytes, acceptedExitCodes,
  });
  try { await git(["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if (error instanceof GitProcessError && /not a git repository/i.test(error.stderr ?? "")) throw new Error("NOT_GIT: workspace is not a git repository");
    throw error;
  }
  const paths = origPath ? [file, origPath] : [file];
  const statusOutput = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths])).stdout;
  const xy = statusOutput.slice(0, 2);
  let status: WorkspaceGitStatus | "unchanged";
  if (!statusOutput) status = "unchanged";
  else if (xy === "??") status = "untracked";
  else if (xy.includes("U") || xy === "AA" || xy === "DD") status = "conflicted";
  else if (xy.includes("R") || origPath) status = "renamed";
  else if (xy.includes("D")) status = "deleted";
  else if (xy.includes("A")) status = "added";
  else if (xy.includes("T")) status = "typechange";
  else status = "modified";
  if (status === "unchanged") {
    try { await git(["ls-files", "--error-unmatch", "--", file]); }
    catch (error) { if (error instanceof GitProcessError && error.code === "PROCESS_FAILED") throw new Error("NOT_FOUND: file not found"); throw error; }
    return {status, text:"", truncated:false, binary:false};
  }
  if (status === "untracked" && !current.info) throw new Error("NOT_FOUND: file not found");
  const args = status === "untracked"
    ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file]
    : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "-M", "--", ...paths];
  const result = await git(args, MAX_DIFF_BYTES, status === "untracked" ? [0,1] : [0]);
  const binary = /^Binary files .* differ$/m.test(result.stdout);
  return {status, text:binary ? "" : result.stdout, truncated:!!result.truncated, binary};
}
