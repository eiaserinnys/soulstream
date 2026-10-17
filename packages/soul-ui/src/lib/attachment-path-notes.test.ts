import { describe, expect, it } from "vitest";

import { appendAttachmentPathNotes, removeRepresentedAttachmentPathNotes } from "./attachment-path-notes";

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

it("hides only exact path-note lines for attachments actually displayed", () => {
  const items = [{ source: { kind: "legacy", path: "/incoming/a.txt" }, legacySources: [] },
    { source: { kind: "asset" }, legacySources: [{ path: "/incoming/b.txt" }] }] as unknown as import("./chat-attachment-model").ChatAttachmentItem[];
  const text = "本文\n\n[첨부 파일 로컬 경로: /incoming/a.txt]\n[첨부 파일 로컬 경로: /incoming/b.txt]\n[첨부 파일 로컬 경로: /other/a.txt]\n예: [첨부 파일 로컬 경로: /incoming/a.txt]";
  expect(removeRepresentedAttachmentPathNotes(text, items)).toBe("本文\n\n[첨부 파일 로컬 경로: /other/a.txt]\n예: [첨부 파일 로컬 경로: /incoming/a.txt]");
  expect(removeRepresentedAttachmentPathNotes(text, [])).toBe(text);
});
