import { describe, expect, it } from "vitest";

import { appendAttachmentPathNotes } from "./attachment-path-notes";

describe("appendAttachmentPathNotes", () => {
  it("adds model-visible local path notes and avoids duplicates", () => {
    const text = appendAttachmentPathNotes("첨부 처리", ["/tmp/a.png", "/tmp/b.pdf"]);

    expect(text).toBe(
      "첨부 처리\n\n" +
        "[첨부 파일 로컬 경로: /tmp/a.png]\n" +
        "[첨부 파일 로컬 경로: /tmp/b.pdf]",
    );
    expect(appendAttachmentPathNotes(text, ["/tmp/a.png"])).toBe(text);
  });
});
