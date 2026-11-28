import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("PR-CN planner polish contract", () => {
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
