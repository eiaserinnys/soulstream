import path from "node:path";

export type FileActivityRow = {
  event_type: string; tool_name: string | null; created_at: string | Date;
  file_path?: string | null; notebook_path?: string | null; file_path_camel?: string | null;
  absolute_path?: string | null; path_arg?: string | null; target_file?: string | null; result?: string | null;
};
export type FileActivity = { read: boolean; wrote: boolean; last_activity_at: string; last_read_at: string | null };
const agyWrite = new Set(["write_file", "write_to_file", "edit_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"]);
const excluded = new Set(["Grep", "Glob", "Bash", "grep_search", "find_by_name", "run_command", "command"]);
export function collectSessionFileActivity(root: string | null, rows: readonly FileActivityRow[]): Map<string, FileActivity> & { truncated: boolean } {
  const files = Object.assign(new Map<string, FileActivity>(), {truncated:false});
  for (const row of rows) {
    const name=row.tool_name ?? ""; if(excluded.has(name)) continue;
    let paths: unknown[]=[]; let read=false; let wrote=false;
    if (row.event_type === "tool_result" && name === "file_change") {
      try { const changes: unknown=JSON.parse(row.result ?? "[]"); if(Array.isArray(changes)) paths=changes.map(v => typeof v === "string" ? v : v?.path); } catch { continue; }
      wrote=true;
    } else if (row.event_type === "tool_start") {
      if (name === "Read") { paths=[row.file_path]; read=true; }
      else if (["Edit", "Write", "MultiEdit"].includes(name)) { paths=[row.file_path]; wrote=true; }
      else if (name === "NotebookEdit") { paths=[row.notebook_path]; wrote=true; }
      else if (name === "read") { paths=[row.file_path_camel]; read=true; }
      else if (name === "edit" || name === "write") { paths=[row.file_path_camel]; wrote=true; }
      else { paths=[row.absolute_path ?? row.path_arg ?? row.target_file]; wrote=agyWrite.has(name); read=!wrote; }
    }
    const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    for (const value of paths) {
      if (typeof value !== "string" || !value) continue;
      const file=relativePath(root,value); if(!file) continue;
      const old=files.get(file);
      if (!old && files.size >= 5000) { files.truncated=true; continue; }
      files.set(file,{read:!!old?.read || read,wrote:!!old?.wrote || wrote,last_activity_at:old && old.last_activity_at > at ? old.last_activity_at : at,last_read_at:read && (!old?.last_read_at || at > old.last_read_at) ? at : old?.last_read_at ?? null});
    }
  }
  return files;
}
export function relativePath(root: string | null, value: string): string | null {
  const windows = !!root && (/^[a-z]:[\\/]/i.test(root) || root.startsWith("\\\\"));
  const impl=windows ? path.win32 : path.posix;
  const input=value;
  if (!root) {
    if (path.win32.isAbsolute(value) || path.posix.isAbsolute(input)) return null;
    const normalized = path.posix.normalize(input).replace(/\/$/, "");
    return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
  }
  const rel=impl.relative(root,impl.resolve(root,input));
  if (!rel || rel === ".." || rel.startsWith(`..${impl.sep}`) || impl.isAbsolute(rel)) return null;
  return windows ? rel.replaceAll("\\", "/") : rel;
}
