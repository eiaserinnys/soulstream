/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnifiedDiff, SessionFileDiff } from "./SessionFileDiff";
import { reviewSessionFiles } from "./components-review-fixtures";

vi.mock("@seosoyoung/soul-ui", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DashboardIconCap: ({ label, children, ...props }: any) => <button aria-label={label} {...props}>{children}</button>,
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("unified diff", () => {
  // 실제 Git: 일반 파일을 링크로 바꾸고 git diff HEAD -M -- file.txt.
  const typechange = `diff --git a/file.txt b/file.txt
deleted file mode 100644
index 445cea2..0000000
--- a/file.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old one
-old two
diff --git a/file.txt b/file.txt
new file mode 120000
index 0000000..1de5659
--- /dev/null
+++ b/file.txt
@@ -0,0 +1 @@
+target
\\ No newline at end of file`;
  // 실제 Git: git mv file.txt renamed.txt, 내용을 전부 바꾸고 git diff HEAD -M -- renamed.txt file.txt.
  const renamed = `diff --git a/file.txt b/file.txt
deleted file mode 100644
index 445cea2..0000000
--- a/file.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old one
-old two
diff --git a/renamed.txt b/renamed.txt
new file mode 100644
index 0000000..92d56ff
--- /dev/null
+++ b/renamed.txt
@@ -0,0 +1,2 @@
+new one
+new two`;
  it.each([[typechange, ["del", "del", "add"]], [renamed, ["del", "del", "add", "add"]]])("ignores file headers in each Git patch block", (text, kinds) => {
    const lines = parseUnifiedDiff(text);
    expect(lines.map(line => line.kind)).toEqual(kinds);
    expect(lines.filter(line => line.kind !== "hunk").map(line => line.text)).not.toContain("-- /dev/null");
    expect(lines.filter(line => line.kind !== "hunk").map(line => line.text)).not.toContain("++ /dev/null");
  });
  it("parses edits and multiple hunks, omitting metadata, first hunk and newline marker", () => {
    const text = [
      "diff --git a/a b/a", "index 123..456", "--- a/a", "+++ b/a",
      "@@ -1,2 +1,2 @@", " old", "-removed", "+added",
      "\\ No newline at end of file", "@@ -47,2 +48,2 @@ function example()",
      " context", "-before", "+after",
    ].join("\n");
    expect(parseUnifiedDiff(text)).toEqual([
      { kind: "ctx", text: "old", number: 1 },
      { kind: "del", text: "removed", number: 2 },
      { kind: "add", text: "added", number: 2 },
      { kind: "hunk", heading: "function example()" },
      { kind: "ctx", text: "context", number: 48 },
      { kind: "del", text: "before", number: 48 },
      { kind: "add", text: "after", number: 49 },
    ]);
  });
  it.each([
    ["new file mode 100644\n@@ -0,0 +1,1 @@\n+new", ["add"]],
    ["deleted file mode 100644\n@@ -1,1 +0,0 @@\n-old", ["del"]],
    ["similarity index 100%\nrename from a\nrename to b", []],
  ])("handles added, deleted and renamed files", (text, kinds) => {
    expect(parseUnifiedDiff(text).map(line => line.kind)).toEqual(kinds);
  });
});

describe("diff states", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const file = reviewSessionFiles.files[2];
  afterEach(() => { act(() => root.render(null)); vi.unstubAllGlobals(); });
  it("retains the body, its focus and scroll while refreshing the open file", async () => {
    document.body.append(host);
    let resolveRefresh!: (response: any) => void;
    const result = { status: "modified", binary: false, text: "@@ -1 +1 @@\n-old\n+new", truncated: false };
    const request = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => result }).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={file} observedAt="first" onOpenFull={() => {}}/>));
    const body = host.querySelector<HTMLElement>(".v3-session-file-diff-body")!;
    body.focus(); body.scrollTop = 25;
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={file} observedAt="second" onOpenFull={() => {}}/>));
    expect(host.querySelector(".v3-session-file-diff-body")).toBe(body);
    expect(document.activeElement).toBe(body);
    expect(body.scrollTop).toBe(25);
    expect(host.textContent).toContain("new");
    expect(host.querySelector('[role="region"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => resolveRefresh({ ok: true, json: async () => result }));
    expect(document.activeElement).toBe(body);
    host.remove();
  });
  it("sizes the number column from visible line numbers only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "modified", binary: false, text: "@@ -999,1 +1,1 @@\n-old\n+new", truncated: false }) }));
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={file} observedAt={null} onOpenFull={() => {}}/>));
    expect(host.querySelector<HTMLElement>(".v3-session-file-diff-body")?.style.getPropertyValue("--v3-diff-digits")).toBe("1");
  });
  it.each([
    [{ status: 200, data: { status: "modified", binary: true, text: "", truncated: false } }, "바이너리 파일"],
    [{ status: 200, data: { status: "unchanged", binary: false, text: "", truncated: false } }, "바뀐 내용 없음"],
    [{ status: 200, data: { status: "modified", binary: false, text: "@@ -1 +1 @@\n-old\n+new", truncated: true } }, "앞 512KiB만 보입니다"],
    [{ status: 501 }, "이 노드는 아직 변경분을 보이지 않습니다"],
    [{ status: 503 }, "변경분을 불러오지 못했습니다"],
  ])("shows server state %s", async (response, expected) => {
    const request = vi.fn().mockResolvedValue({ ok: response.status === 200, status: response.status, json: async () => "data" in response ? response.data : undefined });
    vi.stubGlobal("fetch", request);
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={file} observedAt={null} onOpenFull={() => {}}/>));
    expect(host.textContent).toContain(expected);
    if (response.status === 503) {
      await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "다시 시도")!.click());
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
  it("uses the full-view trigger and omits it for deleted files", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "deleted", text: "", binary: false, truncated: false }) }));
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={{ ...file, git_status: "deleted" }} observedAt={null} onOpenFull={() => {}}/>));
    expect(host.querySelector('[aria-label="전체 보기"]')).toBeNull();
    const open = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "modified", text: "", binary: false, truncated: false }) }));
    await act(async () => root.render(<SessionFileDiff id="diff" sessionId="s" file={file} observedAt="later" onOpenFull={open}/>));
    const button = host.querySelector<HTMLButtonElement>('[aria-label="전체 보기"]')!;
    act(() => button.click());
    expect(open).toHaveBeenCalledWith(button);
  });
});
