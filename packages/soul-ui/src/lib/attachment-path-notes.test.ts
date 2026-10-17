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

it("hides only trailing exact path-note lines for attachments actually displayed", () => {
  const items = [{ source: { kind: "legacy", path: "/incoming/a.txt" }, legacySources: [] },
    { source: { kind: "asset" }, legacySources: [{ path: "/incoming/b.txt" }] }] as unknown as import("./chat-attachment-model").ChatAttachmentItem[];
  const text = "本文\n\n[첨부 파일 로컬 경로: /other/a.txt]\n예: [첨부 파일 로컬 경로: /incoming/a.txt]\n\n[첨부 파일 로컬 경로: /incoming/a.txt]\n[첨부 파일 로컬 경로: /incoming/b.txt]\n\n";
  expect(removeRepresentedAttachmentPathNotes(text, items)).toBe("本文\n\n[첨부 파일 로컬 경로: /other/a.txt]\n예: [첨부 파일 로컬 경로: /incoming/a.txt]");
  expect(removeRepresentedAttachmentPathNotes(text, [])).toBe(text);
});

it.each([
  "```text\n[첨부 파일 로컬 경로: /incoming/a.txt]\n```",
  "앞 문장\n[첨부 파일 로컬 경로: /incoming/a.txt]\n뒤 문장",
])("preserves user examples above the generated tail: %s", text => {
  const items = [{ source: { kind: "legacy", path: "/incoming/a.txt" }, legacySources: [] }] as unknown as import("./chat-attachment-model").ChatAttachmentItem[];
  expect(removeRepresentedAttachmentPathNotes(text, items)).toBe(text);
  expect(removeRepresentedAttachmentPathNotes(`${text}\n\n[첨부 파일 로컬 경로: /incoming/a.txt]\n`, items)).toBe(text);
});

it.each([false, true])("keeps unrepresented notes in the generated tail (reversed=%s)", reversed => {
  const items = [{ source: { kind: "legacy", path: "/incoming/a.txt" }, legacySources: [] }] as unknown as import("./chat-attachment-model").ChatAttachmentItem[];
  const notes = ["[첨부 파일 로컬 경로: /incoming/a.txt]", "[첨부 파일 로컬 경로: /incoming/b.txt]"];
  if (reversed) notes.reverse();
  expect(removeRepresentedAttachmentPathNotes(`본문\n\n${notes.join("\n")}\n`, items)).toBe("본문\n\n[첨부 파일 로컬 경로: /incoming/b.txt]");
});
