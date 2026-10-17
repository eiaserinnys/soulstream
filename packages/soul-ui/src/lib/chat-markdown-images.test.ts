import { describe, expect, it } from "vitest";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import type { ChatAttachmentItem } from "./chat-attachment-model";
import {
  buildStructuredChatImageItems,
  createChatMarkdownImageModel,
  createChatMarkdownImageRemarkPlugin,
  contextualizeChatMarkdownImageSrc,
  getChatImageFilename,
} from "./chat-markdown-images";

const sessionContext: AttachmentReadContext = { type: "session", id: "session-a" };

function representedAsset(input: {
  attachmentId: string;
  legacySources?: { node_id: string; path: string }[];
}): ChatAttachmentItem {
  return {
    key: `asset:${input.attachmentId}`,
    name: "same.png",
    mimeType: "image/png",
    byteSize: 1,
    previewKind: "image",
    availability: "ready",
    previewUrl: `/api/attachments/${input.attachmentId}/content?context_type=session&context_id=session-a`,
    originalUrl: null,
    legacySources: input.legacySources ?? [],
    source: { kind: "asset", attachmentId: input.attachmentId, context: sessionContext },
  };
}

function runImagePlugin(source: string, imageLines: string[], representedAttachments: readonly ChatAttachmentItem[] = []) {
  const children = imageLines.map((line, index) => {
    const start = source.indexOf(line);
    return {
      type: "paragraph",
      position: { start: { offset: start }, end: { offset: start + line.length } },
      children: [{ type: "image" }],
    };
  });
  const root = { type: "root", children } as never;
  const model = createChatMarkdownImageModel("user", [], representedAttachments, sessionContext);
  const transform = createChatMarkdownImageRemarkPlugin(model)();

  transform(root, { value: source });
  return { model, root: root as { children: Array<{ type: string; data?: { hProperties?: Record<string, unknown> } }> } };
}

describe("chat image sources", () => {
  it("keeps only supported image attachment paths and preserves their order", () => {
    const images = buildStructuredChatImageItems([
      "/incoming/first.png",
      "/incoming/readme.txt",
      "/incoming/second.HEIC",
    ], "node / one");

    expect(images).toEqual([
      {
        id: "attachment:0:/incoming/first.png",
        src: "/api/attachments/files?nodeId=node%20%2F%20one&path=%2Fincoming%2Ffirst.png",
        alt: "",
      },
    ]);
  });

  it("adds the provided read context to legacy image URLs and excludes HEIC", () => {
    expect(buildStructuredChatImageItems([
      "/incoming/first.png",
      "/incoming/photo.HEIC",
      "/incoming/second.webp",
    ], "node-a", sessionContext)).toEqual([
      {
        id: "attachment:0:/incoming/first.png",
        src: "/api/attachments/files?nodeId=node-a&path=%2Fincoming%2Ffirst.png&context_type=session&context_id=session-a",
        alt: "",
      },
      {
        id: "attachment:2:/incoming/second.webp",
        src: "/api/attachments/files?nodeId=node-a&path=%2Fincoming%2Fsecond.webp&context_type=session&context_id=session-a",
        alt: "",
      },
    ]);
  });

  it("does not add session context to an external image origin", () => {
    const external = "https://images.example/api/attachments/files?nodeId=node-a&path=%2Fsame.png";
    expect(contextualizeChatMarkdownImageSrc(external, sessionContext)).toBe(external);
  });

  it("keeps a represented legacy path out of the structured Markdown gallery", () => {
    const represented = representedAsset({
      attachmentId: "asset-one",
      legacySources: [{ node_id: "node-a", path: "/same.png" }],
    });
    expect(buildStructuredChatImageItems(["/same.png", "/other.png"], "node-a", sessionContext, [represented]))
      .toEqual([{
        id: "attachment:1:/other.png",
        src: "/api/attachments/files?nodeId=node-a&path=%2Fother.png&context_type=session&context_id=session-a",
        alt: "",
      }]);
  });

  it("does not invent a source node when the event and session lack one", () => {
    expect(buildStructuredChatImageItems(["/incoming/first.png"], undefined)).toEqual([]);
  });

  it("gets a real basename from a protected path query or URL pathname", () => {
    expect(getChatImageFilename("/api/attachments/files?path=%2Fincoming%2Ffirst%20image.png"))
      .toBe("first image.png");
    expect(getChatImageFilename("https://images.test/path/second.png?size=large"))
      .toBe("second.png");
    expect(getChatImageFilename("https://images.test/"))
      .toBeUndefined();
  });

  it("suppresses only an inline image whose internal attachment ID is already represented", () => {
    const source = [
      "![duplicate](/api/attachments/asset-one/content?context_type=session&context_id=session-a)",
      "![same basename](/api/attachments/files?nodeId=node-b&path=%2Fsame.png)",
    ].join("\n\n");
    const result = runImagePlugin(source, [
      "![duplicate](/api/attachments/asset-one/content?context_type=session&context_id=session-a)",
      "![same basename](/api/attachments/files?nodeId=node-b&path=%2Fsame.png)",
    ], [representedAsset({ attachmentId: "asset-one", legacySources: [{ node_id: "node-a", path: "/same.png" }] })]);

    expect(result.model.gallery).toEqual([{
      id: `markdown:${source.indexOf("![same basename](/api/attachments/files?nodeId=node-b&path=%2Fsame.png)")}:/api/attachments/files?nodeId=node-b&path=%2Fsame.png`,
      src: "/api/attachments/files?nodeId=node-b&path=%2Fsame.png&context_type=session&context_id=session-a",
      alt: "same basename",
    }]);
    expect(result.root.children).toHaveLength(1);
  });

  it("suppresses an exact legacy source pair but keeps the same basename from another node", () => {
    const source = [
      "![alias](/api/attachments/files?nodeId=node-a&path=%2Fsame.png)",
      "![other node](/api/attachments/files?nodeId=node-b&path=%2Fsame.png)",
    ].join("\n\n");
    const result = runImagePlugin(source, [
      "![alias](/api/attachments/files?nodeId=node-a&path=%2Fsame.png)",
      "![other node](/api/attachments/files?nodeId=node-b&path=%2Fsame.png)",
    ], [representedAsset({ attachmentId: "asset-one", legacySources: [{ node_id: "node-a", path: "/same.png" }] })]);

    expect(result.model.gallery).toHaveLength(1);
    expect(result.model.gallery[0]?.alt).toBe("other node");
    expect(result.model.gallery[0]?.src).toContain("nodeId=node-b");
    expect(result.model.gallery[0]?.src).toContain("context_id=session-a");
  });

  it("leaves a mixed text and external image paragraph unchanged", () => {
    const source = "텍스트 ![external](https://images.example/same.png) 설명";
    const result = runImagePlugin(source, [source]);

    expect(result.model.gallery).toEqual([]);
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0]?.data).toBeUndefined();
  });
});
