import type { SessionWorkspaceSessionDiffResponse } from "@soulstream/wire-schema/session-workspace";
import { relativePath } from "./session_file_activity.js";

type Event = { event_type: string; payload: any; created_at: Date | string };
type Edit = SessionWorkspaceSessionDiffResponse["edits"][number];
const pathOnly = new Set(["edit_file", "write_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit", "NotebookEdit", "edit", "write"]);
const lines = (value: string) => value === "" ? [] : value.replace(/\n$/, "").split("\n");
function whole(value: string, kind: "add" | "delete"): string {
  const parts = lines(value); const n = parts.length;
  return `${kind === "add" ? `@@ -0,0 +1,${n} @@` : `@@ -1,${n} +0,0 @@`}\n${parts.map(line => `${kind === "add" ? "+" : "-"}${line}`).join("\n")}`;
}
function editHunk(oldValue: string, newValue: string): string {
  const old = lines(oldValue), next = lines(newValue);
  let start = 0, end = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
  return ["@@ @@", ...old.slice(0, start).map(x => ` ${x}`), ...old.slice(start, old.length - end).map(x => `-${x}`), ...next.slice(start, next.length - end).map(x => `+${x}`), ...old.slice(old.length - end).map(x => ` ${x}`)].join("\n");
}
type Sink = { edit(path: string, edit: Edit, truncated: boolean): void; unrecorded(path: string, truncated: boolean): void };
// 사건을 편집으로 만드는 규칙의 정본. 세션 기록 탭(collectSessionFileEdits)과 줄 수 세기(countSessionFileEdits)가 함께 쓴다.
function scanEdits(root: string | null, events: readonly Event[], wanted: (path: string) => boolean, sink: Sink): void {
  const failed = new Set(events.filter(e => e.event_type === "tool_result" && e.payload?.is_error === true).map(e => e.payload.tool_use_id).filter(Boolean));
  const target = (value: unknown) => { if (typeof value !== "string") return null; const rel = relativePath(root, value); return rel !== null && wanted(rel) ? rel : null; };
  for (const event of events) {
    const p = event.payload; if (!p || typeof p !== "object") continue;
    const tool = p.tool_name; const input = p.tool_input ?? {};
    const at = new Date(event.created_at).toISOString();
    const truncated = !!p.truncation;
    const push = (path: string, kind: Edit["kind"], text: string, line_numbers: boolean, replace_all = false) => sink.edit(path, {at, tool, kind, text, line_numbers, replace_all}, truncated);
    if (event.event_type === "tool_start" && !failed.has(p.tool_use_id)) {
      const path = target(input.file_path ?? input.notebook_path ?? input.filePath ?? input.AbsolutePath ?? input.Path ?? input.TargetFile);
      if (path === null) continue;
      if (tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") push(path, "edit", editHunk(input.old_string, input.new_string), false, input.replace_all === true);
      else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
        const hunks = input.edits.filter((e: any) => typeof e.old_string === "string" && typeof e.new_string === "string");
        if (hunks.length) push(path, "edit", hunks.map((e: any) => editHunk(e.old_string, e.new_string)).join("\n"), false, hunks.some((e: any) => e.replace_all === true));
        else sink.unrecorded(path, false);
      } else if (tool === "Write" && typeof input.content === "string") push(path, "write", whole(input.content, "add"), true);
      else if (pathOnly.has(tool) || ["Edit", "Write"].includes(tool)) sink.unrecorded(path, truncated);
    } else if (event.event_type === "tool_result" && tool === "file_change" && !p.is_error) {
      let changes: any; try { changes = JSON.parse(p.result); } catch { continue; }
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const path = target(change?.path);
        if (path === null || typeof change.diff !== "string") continue;
        const kind = change.kind?.type;
        if (kind === "update") push(path, "edit", change.diff, true);
        else if (kind === "add" || kind === "delete") push(path, kind, whole(change.diff, kind), true);
      }
    }
  }
}
export function collectSessionFileEdits(root: string | null, path: string, events: readonly Event[]): SessionWorkspaceSessionDiffResponse {
  const result: SessionWorkspaceSessionDiffResponse = { path, edits: [], unrecorded: 0, truncated: false };
  scanEdits(root, events, rel => rel === path, {
    edit: (_p, edit, truncated) => { result.edits.push(edit); if (truncated) result.truncated = true; },
    unrecorded: (_p, truncated) => { result.unrecorded++; if (truncated) result.truncated = true; },
  });
  let size = result.edits.reduce((sum, e) => sum + Buffer.byteLength(e.text), 0);
  while (size > 512 * 1024 && result.edits.length) { size -= Buffer.byteLength(result.edits.shift()!.text); result.truncated = true; }
  return result;
}
/** 세션 기록 탭의 덩이들과 같은 규칙으로 센 경로별 누적 줄 수. 512KiB 상한은 적용하지 않는다. 내용 있는 편집이 없는 경로는 결과에 없다. */
export function countSessionFileEdits(root: string | null, paths: ReadonlySet<string>, events: readonly Event[]): Map<string, { added: number; deleted: number }> {
  const counts = new Map<string, { added: number; deleted: number }>();
  scanEdits(root, events, rel => paths.has(rel), {
    edit: (path, edit) => {
      const count = counts.get(path) ?? { added: 0, deleted: 0 };
      for (const line of edit.text.split("\n")) {
        if (line.startsWith("@@")) continue;
        if (line.startsWith("+")) count.added++; else if (line.startsWith("-")) count.deleted++;
      }
      counts.set(path, count);
    },
    unrecorded: () => {},
  });
  return counts;
}
