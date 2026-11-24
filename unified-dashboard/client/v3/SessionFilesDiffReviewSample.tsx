import { useCallback, useEffect, useRef } from "react";
import type { WorkspaceGitStatus } from "../../../packages/wire-schema/src/session_workspace";
import { SessionFileDiffFetchContext } from "./SessionFileDiff";
import { SessionFilesPanel } from "./SessionFilesPanel";
import { reviewSessionFiles, reviewSessionFileHistory } from "./components-review-fixtures";

type Scene = "diff" | "added" | "deleted" | "renamed" | "binary" | "truncated" | "loading" | "error" | "unsupported" | "session" | "tabs" | "no-workspace" | "unrecorded" | "mixed" | "session-truncated";
const labels: Record<Scene, string> = {
  diff: "변경분", added: "새 파일", deleted: "지움", renamed: "이름 바꿈", binary: "바이너리",
  truncated: "잘림", loading: "불러오는 중", error: "실패", unsupported: "옛 노드",
  session: "세션 기록", tabs: "두 탭", "no-workspace": "삭제된 작업 폴더", unrecorded: "내용 없는 엔진", mixed: "일부 기록", "session-truncated": "긴 기록",
};
const patch = "@@ -1,2 +1,2 @@\n context\n-before\n+after\n@@ -12,1 +12,1 @@ function example()\n+새 코드\n";

function DiffScene({ scene }: { scene: Scene }) {
  const host = useRef<HTMLElement>(null);
  const path = scene === "binary" ? "sample.bin" : `${scene}.ts`;
  const status: WorkspaceGitStatus = scene === "added" ? "added" : scene === "deleted" ? "deleted" : scene === "renamed" ? "renamed" : "modified";
  const sessionScene = ["session", "tabs", "no-workspace", "unrecorded", "mixed", "session-truncated"].includes(scene);
  const file = { ...reviewSessionFiles.files[2], path, git_status: sessionScene && scene !== "tabs" ? null : status, orig_path: scene === "renamed" ? "before.ts" : null, wrote: scene !== "binary", read: false };
  const data = { ...reviewSessionFiles, ...(scene === "no-workspace" ? {root:null,snapshot:null,node:{...reviewSessionFiles.node,status:"no_workspace" as const}} : {}), files: [file], read_only: [] };
  useEffect(() => {
    const button = [...(host.current?.querySelectorAll<HTMLButtonElement>(".v3-session-files-row") ?? [])].find(row => row.textContent?.includes(path));
    button?.click();
  }, [path]);
  const request = useCallback<typeof fetch>(async (url, init) => {
    if (scene === "loading") return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    if (scene === "error" || scene === "unsupported") return new Response(null, { status: scene === "error" ? 503 : 501 });
    if (String(url).includes("/session-diff")) return new Response(JSON.stringify({...reviewSessionFileHistory,path,edits:scene === "unrecorded" ? [] : reviewSessionFileHistory.edits,unrecorded:scene === "unrecorded" || scene === "mixed" ? 2 : 0,truncated:scene === "session-truncated"}),{status:200,headers:{"Content-Type":"application/json"}});
    const text = scene === "added" ? "@@ -0,0 +1,1 @@\n+새 파일\n" : scene === "deleted" ? "@@ -1,1 +0,0 @@\n-지운 파일\n" : scene === "renamed" ? "" : patch;
    return new Response(JSON.stringify({ path, status, text, binary: scene === "binary", truncated: scene === "truncated" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }, [scene, path, status]);
  return <section ref={host} className="v3-detail-pane v3-session-files-pane border border-glass-border glass-strong glass-chrome lg-rim" data-session-files-scene={scene} aria-label={labels[scene]}>
    <SessionFileDiffFetchContext.Provider value={request}>
      <SessionFilesPanel sessionId="components-session" data={data} loading={false} error={false} onRefresh={() => {}} onClose={() => {}} initiallyOtherOpen={scene === "binary"}/>
    </SessionFileDiffFetchContext.Provider>
  </section>;
}

export function SessionFilesDiffReviewSample() {
  return <>{(Object.keys(labels) as Scene[]).map(scene => <DiffScene key={scene} scene={scene}/>)}</>;
}
