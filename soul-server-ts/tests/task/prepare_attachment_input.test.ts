import { describe, expect, it, vi } from "vitest";

import type { AttachmentDescriptor, AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import type { MaterializedAttachment } from "../../src/attachments/attachment_materializer.js";
import {
  createAttachmentInputPreparer,
  stripManagedAttachmentPathNotes,
} from "../../src/task/prepare_attachment_input.js";

type MaterializeInput = {
  sessionId: string;
  attachmentId: string;
  mode: "input" | "resolve";
  deliveryId?: string;
};

function materialized(attachmentId: string, mimeType = "application/pdf"): MaterializedAttachment {
  const image = mimeType === "image/png";
  const descriptor: AttachmentDescriptor = {
    attachment_id: attachmentId,
    name: image ? "image.png" : "document.pdf",
    mime_type: mimeType,
    byte_size: 1,
    checksum_sha256: "0".repeat(64),
    width: null,
    height: null,
    preview_kind: image ? "image" : "info",
    preview_mime_type: null,
  };
  return {
    attachment_id: attachmentId,
    local_path: image ? `/cache/${attachmentId}.png` : `/cache/${attachmentId}.pdf`,
    descriptor,
  };
}

function makePreparer(options: { imageIds?: string[]; failId?: string } = {}) {
  const failure = new Error("materialization failed");
  const materialize = vi.fn(async (input: MaterializeInput): Promise<MaterializedAttachment> => {
    if (input.attachmentId === options.failId) throw failure;
    return materialized(input.attachmentId, options.imageIds?.includes(input.attachmentId) ? "image/png" : undefined);
  });
  return {
    prepare: createAttachmentInputPreparer({ materialize }),
    materialize,
    failure,
  };
}

const binding = (attachmentId: string, path: string): AttachmentPathBinding => ({
  attachment_id: attachmentId,
  node_id: "node-a",
  path,
});

describe("createAttachmentInputPreparer", () => {
  it("keeps legacy input and dedupes its paths without materializing", async () => {
    const { prepare, materialize } = makePreparer();
    const source = {
      sessionId: "session-1",
      text: "legacy text",
      attachmentPaths: ["/legacy/report.pdf", "/legacy/report.pdf"],
    };
    const original = structuredClone(source);

    await expect(prepare(source)).resolves.toEqual({
      text: "legacy text",
      attachmentPaths: ["/legacy/report.pdf"],
      imageAttachmentPaths: [],
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(source).toEqual(original);
  });

  it("replaces a bound legacy path once and materializes duplicate IDs once", async () => {
    const { prepare, materialize } = makePreparer({ imageIds: ["asset-a"] });
    const source = {
      sessionId: "session-1",
      text: "raw text",
      attachmentIds: ["asset-a", "asset-a"],
      attachmentPaths: ["/legacy/photo.jpg", "/legacy/photo.jpg"],
      attachmentBindings: [binding("asset-a", "/legacy/photo.jpg")],
      deliveryId: "delivery-1",
    };
    const original = structuredClone(source);

    const result = await prepare(source);

    expect(result).toEqual({
      text: "raw text",
      attachmentPaths: ["/cache/asset-a.png"],
      imageAttachmentPaths: ["/cache/asset-a.png"],
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0]?.[0]).toEqual({
      sessionId: "session-1",
      attachmentId: "asset-a",
      mode: "input",
      deliveryId: "delivery-1",
    });
    expect(source).toEqual(original);
  });

  it("adds ID-only cache paths before unbound legacy paths", async () => {
    const { prepare } = makePreparer({ imageIds: ["asset-a"] });

    await expect(prepare({
      sessionId: "session-1",
      text: "",
      attachmentIds: ["asset-a"],
      attachmentPaths: ["/legacy/unknown.pdf"],
    })).resolves.toEqual({
      text: "",
      attachmentPaths: ["/cache/asset-a.png", "/legacy/unknown.pdf"],
      imageAttachmentPaths: ["/cache/asset-a.png"],
    });
  });

  it("keeps legacy image paths after materialized images in the image list", async () => {
    const { prepare } = makePreparer({ imageIds: ["asset-a"] });

    await expect(prepare({
      sessionId: "session-1",
      text: "images",
      attachmentIds: ["asset-a"],
      attachmentPaths: ["/legacy/other.jpg", "/legacy/document.pdf"],
    })).resolves.toEqual({
      text: "images",
      attachmentPaths: ["/cache/asset-a.png", "/legacy/other.jpg", "/legacy/document.pdf"],
      imageAttachmentPaths: ["/cache/asset-a.png", "/legacy/other.jpg"],
    });
  });

  it("rejects the whole preparation when any attachment fails", async () => {
    const { prepare, materialize, failure } = makePreparer({ failId: "asset-b" });

    await expect(prepare({
      sessionId: "session-1",
      text: "two files",
      attachmentIds: ["asset-a", "asset-b"],
    })).rejects.toBe(failure);
    expect(materialize.mock.calls.map(([request]) => request.attachmentId)).toEqual(["asset-a", "asset-b"]);
  });
});

describe("stripManagedAttachmentPathNotes", () => {
  const oldPath = "/legacy/a.pdf";
  const oldImagePath = "/legacy/b.png";
  const note = (path: string) => `[첨부 파일 로컬 경로: ${path}]`;
  const bindings = [binding("asset-a", oldPath), binding("asset-b", oldImagePath)];

  it("removes only the exact trailing note block for current bindings", () => {
    expect(stripManagedAttachmentPathNotes(
      `analyze this\n\n${note(oldPath)}\n${note(oldImagePath)}`,
      bindings,
    )).toBe("analyze this");
  });

  it("returns empty text when only managed notes remain", () => {
    expect(stripManagedAttachmentPathNotes(note(oldPath), bindings)).toBe("");
  });

  it.each([
    `keep this ${note(oldPath)} inline`,
    `keep this\n\n${note(oldPath)}\nuser text`,
    `keep this\n\n${note(oldPath)}\n${note("/legacy/unknown.pdf")}`,
  ])("preserves non-trailing or unbound note text", (text) => {
    expect(stripManagedAttachmentPathNotes(text, bindings)).toBe(text);
  });
});
