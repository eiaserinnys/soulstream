import { describe, expect, it } from "vitest";

import { appendAttachmentPathNotes } from "../../src/task/attachment_path_note.js";

describe("appendAttachmentPathNotes", () => {
  it("appends every attachment path as model-visible note lines", () => {
    expect(
      appendAttachmentPathNotes("이미지 확인", [
        "/home/node/.local/incoming/sess-1/a.png",
        "/home/node/.local/incoming/sess-1/b.pdf",
      ]),
    ).toBe(
      "이미지 확인\n\n" +
        "[첨부 파일 로컬 경로: /home/node/.local/incoming/sess-1/a.png]\n" +
        "[첨부 파일 로컬 경로: /home/node/.local/incoming/sess-1/b.pdf]",
    );
  });

  it("is idempotent for notes already appended by a client boundary", () => {
    const text =
      "이미지 확인\n\n" +
      "[첨부 파일 로컬 경로: /home/node/.local/incoming/sess-1/a.png]";

    expect(
      appendAttachmentPathNotes(text, ["/home/node/.local/incoming/sess-1/a.png"]),
    ).toBe(text);
  });

  it("ignores blank paths", () => {
    expect(appendAttachmentPathNotes("본문", ["", "  "])).toBe("본문");
  });
});
