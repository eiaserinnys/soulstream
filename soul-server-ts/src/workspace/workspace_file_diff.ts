import type { SessionWorkspaceDiffResponse, WorkspaceGitStatus } from "@soulstream/wire-schema/session-workspace";
import { GitProcessError, runBoundedProcess } from "../worktree/worktree_process.js";
import { validateWorkspacePath } from "./workspace_file_path.js";

const MAX_DIFF_BYTES = 512 * 1024;
export async function diffWorkspaceFile(root: string, file: string, origPath: string | null): Promise<Omit<SessionWorkspaceDiffResponse, "path">> {
  const current = await validateWorkspacePath(root, file, true);
  if (origPath) await validateWorkspacePath(root, origPath, true);
  const git = (args:string[], maxStdoutBytes?:number, acceptedExitCodes?:number[], stdin?:string) => runBoundedProcess({
    command:"git", args:["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotepath=false", ...args], cwd:root,
    timeoutMs:30_000, maxStdoutBytes, acceptedExitCodes, stdin,
  });
  try { await git(["rev-parse", "--show-toplevel"]); }
  catch (error) {
    if (error instanceof GitProcessError && /not a git repository/i.test(error.stderr ?? "")) throw new Error("NOT_GIT: workspace is not a git repository");
    throw error;
  }
  const prefix=(await git(["rev-parse","--show-prefix"])).stdout.replace(/\r?\n$/, "");
  const paths = origPath ? [file, origPath] : [file];
  const statusOutput = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths])).stdout;
  const records=statusOutput.split("\0");
  let xy=""; let actualOrig:string|null=null;
  const same=(a:string,b:string)=>a === b;
  for(let i=0;i<records.length;i++) {
    const record=records[i]!; if(!record) continue;
    const code=record.slice(0,2), name=record.slice(3);
    const old=code.includes("R") || code.includes("C") ? records[++i] ?? null : null;
    if(same(name,prefix+file)) { xy=code; actualOrig=old; break; }
  }
  let status: WorkspaceGitStatus | "unchanged";
  if (!xy) status = "unchanged";
  else if (xy === "??") status = "untracked";
  else if (xy.includes("U") || xy === "AA" || xy === "DD") status = "conflicted";
  else if (xy.includes("R")) status = "renamed";
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
  let args:string[];
  if(status === "untracked") args=["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file];
  else {
    const head=await git(["rev-parse","--verify","HEAD"],undefined,[0,128]);
    const base=head.exitCode === 0 ? "HEAD" : (await git(["hash-object","-t","tree","--stdin"],undefined,undefined,"")).stdout.trim();
    const diffPaths=status === "renamed" && origPath && actualOrig && same(prefix+origPath,actualOrig) ? [file,origPath] : [file];
    args=["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, "-M", "--", ...diffPaths];
  }
  const result = await git(args, MAX_DIFF_BYTES, status === "untracked" ? [0,1] : [0]);
  if(status === "untracked" && result.exitCode === 1 && !result.stdout) throw new GitProcessError("PROCESS_FAILED", `git diff failed: ${result.stderr.trim()}`, true, 1, result.stderr);
  const binary = /^Binary files .* differ$/m.test(result.stdout);
  return {status, text:binary ? "" : result.stdout, truncated:!!result.truncated, binary};
}
