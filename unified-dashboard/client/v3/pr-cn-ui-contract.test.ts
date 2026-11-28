import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("PR-CN planner polish contract", () => {
  it("keeps folder creation and card sections in their owning surfaces", () => {
    const layout = read("./V3DashboardLayout.tsx");
    const toolbar = read("./V3GlobalToolbar.tsx");
    const home = read("./CardHome.tsx");
    const navigation = read("./V3Navigation.tsx");

    expect(toolbar).not.toContain("onOpenNewTask");
    expect(home).not.toContain("역대 폴더");
    expect(navigation).toMatch(/label="새 폴더"[\s\S]*?onClick=\{\(\) => \{ setProjectDialog\(\{ mode: "create", parentFolderId: null, parentName: null \}\); setError\(null\); \}\}/);
    expect(navigation).toContain("target={projectDialog}");
    expect(navigation).toContain("onCreateIdentity={onCreateProject}");
    expect(layout).toContain('createLabel="새 폴더"');
    expect(layout).toContain("folderSessions.state?.items.map");
    expect(navigation).toContain("<h2>중요 작업</h2>");
    expect(navigation).not.toContain("<h2>★ 작업</h2>");
    expect(home).toContain("<CardInbox");
    expect(home).toContain("<CardHandoff");
  });

  it("removes session-only guidance and reuses the attachment submission contract", () => {
    const modal = read("./SessionSuccessionModal.tsx");

    expect(modal).not.toContain("추가 지침");
    expect(modal).not.toContain("setGuidance");
    expect(modal).toContain("useFileUpload");
    expect(modal).toContain("appendAttachmentPathNotes");
    expect(modal).toContain("attachmentPaths");
    expect(modal).toContain("/api/attachments/sessions?nodeId=");
    expect(modal).toContain("resetLocal");
    expect(modal).toContain("cancel");
  });
});
