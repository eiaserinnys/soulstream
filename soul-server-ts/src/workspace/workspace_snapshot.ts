import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { NodeWorkspaceSnapshot, WorkspaceGitFile, WorkspaceGitSnapshot, WorkspaceGitStatus } from "@soulstream/wire-schema/session-workspace";
import { GitProcessError, runBoundedProcess } from "../worktree/worktree_process.js";

type CacheEntry = { value?: NodeWorkspaceSnapshot; promise?: Promise<NodeWorkspaceSnapshot>; marker?: string; since: string; checkedAt: number };
const EMPTY = (root: string): NodeWorkspaceSnapshot => ({ root, state: "pending", observed_at: null, refreshing: true, git: null });
export class WorkspaceSnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly roots = new Map<string, string | null>();
  constructor(private readonly pendingMs = 3000) {}
  async get(workspace: string, since: string): Promise<NodeWorkspaceSnapshot> {
    const root = await realpath(workspace).catch(() => { throw new Error("NOT_FOUND: workspace not found"); });
    let entry = this.entries.get(root);
    if (!entry) { entry = { since, checkedAt: 0 }; this.entries.set(root, entry); }
    const marker = await gitMarker(this.roots.get(root) ?? root);
    const stale = !entry.value || Date.now() - entry.checkedAt > 10_000 || marker !== entry.marker || since < entry.since;
    if (stale && !entry.promise) {
      entry.since = since < entry.since ? since : entry.since;
      const current = entry;
      entry.promise = this.compute(root, entry.since).then(async value => {
        current.value = value; current.marker = await gitMarker(this.roots.get(root) ?? root); current.checkedAt = Date.now(); return value;
      }).finally(() => { current.promise = undefined; });
      // The calculation may finish after the first caller receives pending.
      void entry.promise.catch(() => {});
    }
    if (entry.value) return filterSince({ ...entry.value, refreshing: !!entry.promise }, since);
    const value = await Promise.race([entry.promise!, new Promise<null>(resolve => setTimeout(() => resolve(null), this.pendingMs))]);
    return value ? filterSince(value, since) : EMPTY(root);
  }
  private async compute(root: string, since: string): Promise<NodeWorkspaceSnapshot> {
    let gitRoot = this.roots.get(root);
    if (gitRoot === undefined) {
      try { gitRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim(); }
      catch (e) {
        if (e instanceof GitProcessError && e.code === "PROCESS_FAILED" && /not a git repository/i.test(e.stderr ?? "")) gitRoot = null;
        else throw e;
      }
      this.roots.set(root, gitRoot);
    }
    if (gitRoot === null) return { root, state: "not_git", observed_at: new Date().toISOString(), refreshing: false, git: null };
    const [status, diff, log] = await Promise.all([
      git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--", "."]),
      git(root, ["diff", "HEAD", "--numstat", "-z", "--", "."]).catch(e => { if (e instanceof GitProcessError && /unknown revision|ambiguous argument|bad revision/i.test(e.stderr ?? "")) return ""; throw e; }),
      git(root, ["log", `--since=${since}`, "-n", "50", "--format=%x1e%H%x00%s%x00%cI", "--name-only", "-z", "HEAD", "--", "."]).catch(e => { if (e instanceof GitProcessError && /does not have any commits|unknown revision|ambiguous argument/i.test(e.stderr ?? "")) return ""; throw e; }),
    ]);
    const convert = (p: string) => path.relative(root, path.resolve(gitRoot!, p.replaceAll("\\", "/"))).split(path.sep).join("/");
    const result = parseStatus(status, convert);
    const counts = parseNumstat(diff, convert);
    await Promise.all(result.files.map(async file => {
      const n = counts.get(file.path); if (n && file.status !== "untracked") { file.added = n[0]; file.deleted = n[1]; }
      if (file.status !== "deleted") { const info = await stat(path.resolve(root, file.path)).catch(() => null); file.size = info?.isFile() ? info.size : null; }
    }));
    result.commits = parseLog(log, convert);
    result.truncated = result.files.length > 1000; result.files = result.files.slice(0, 1000);
    return { root, state: "ready", observed_at: new Date().toISOString(), refreshing: false, git: result };
  }
}
function filterSince(snapshot: NodeWorkspaceSnapshot, since: string): NodeWorkspaceSnapshot {
  if (!snapshot.git) return snapshot;
  const threshold = Date.parse(since);
  return { ...snapshot, git: { ...snapshot.git, commits: snapshot.git.commits.filter(commit => Date.parse(commit.committed_at) >= threshold) } };
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await runBoundedProcess({ command: "git", args: ["--no-optional-locks", "-c", "core.quotepath=false", ...args], cwd, timeoutMs: 30_000 })).stdout;
}
async function gitMarker(root: string): Promise<string> {
  let dir = path.join(root, ".git");
  const info = await stat(dir).catch(() => null);
  if (info?.isFile()) { const text = await readFile(dir, "utf8"); const match = /^gitdir:\s*(.+)\s*$/m.exec(text); if (match) dir = path.resolve(root, match[1]!.trim()); }
  const values = await Promise.all(["index", "HEAD"].map(async n => (await stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0));
  return values.join(":");
}
function parseStatus(text: string, convert: (path: string) => string): WorkspaceGitSnapshot {
  const result: WorkspaceGitSnapshot = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, truncated: false, files: [], commits: [] };
  const records = text.split("\0");
  for (let i=0; i<records.length; i++) {
    const r = records[i]!;
    if (r.startsWith("# branch.oid ")) { const v=r.slice(13); result.head=v === "(initial)" ? null : v; }
    else if (r.startsWith("# branch.head ")) { const v=r.slice(14); result.branch=v === "(detached)" ? null : v; }
    else if (r.startsWith("# branch.upstream ")) result.upstream=r.slice(18);
    else if (r.startsWith("# branch.ab ")) { const m=/\+(\d+) -(\d+)/.exec(r); if(m){result.ahead=Number(m[1]);result.behind=Number(m[2]);} }
    else if (r.startsWith("? ")) result.files.push(makeFile(convert(r.slice(2)), "untracked", null));
    else if (r.startsWith("1 ") || r.startsWith("2 ") || r.startsWith("u ")) {
      const kind=r[0]; const m=kind === "1" ? /^1 (\S+) (?:\S+ ){6}(.+)$/s.exec(r) : kind === "2" ? /^2 (\S+) (?:\S+ ){7}(.+)$/s.exec(r) : /^u (\S+) (?:\S+ ){8}(.+)$/s.exec(r);
      if (!m) continue;
      const xy=m[1]!; const status: WorkspaceGitStatus = kind === "u" ? "conflicted" : kind === "2" ? "renamed" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : xy.includes("T") ? "typechange" : "modified";
      const orig = kind === "2" ? convert(records[++i]!) : null;
      result.files.push(makeFile(convert(m[2]!), status, orig));
    }
  }
  return result;
}
function makeFile(file: string, status: WorkspaceGitStatus, orig_path: string | null): WorkspaceGitFile { return {path:file,status,orig_path,added:null,deleted:null,size:null}; }
function parseNumstat(text: string, convert: (path:string)=>string): Map<string, [number|null, number|null]> {
  const result=new Map<string,[number|null,number|null]>(); const parts=text.split("\0");
  for(let i=0;i<parts.length;i++) { const m=/^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]!); if(!m) continue; let file=m[3]!; if(!file){ i++; file=parts[++i] ?? ""; } result.set(convert(file),[m[1] === "-" ? null : Number(m[1]),m[2] === "-" ? null : Number(m[2])]); }
  return result;
}
function parseLog(text: string, convert: (path:string)=>string): WorkspaceGitSnapshot["commits"] {
  return text.split("\x1e").slice(1).map(record => {
    const [sha="",subject="",date="",...files]=record.split("\0");
    return {sha:sha.trim(),subject,committed_at:date.trim(),files:files.map(f=>f.replace(/^\n+/, "")).filter(Boolean).map(convert)};
  });
}
