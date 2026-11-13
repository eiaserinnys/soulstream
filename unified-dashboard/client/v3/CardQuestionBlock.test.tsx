/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardQuestion } from "@seosoyoung/soul-ui/cards/card-types";
import { CardQuestionBody, type CardQuestionView } from "./CardQuestionBlock";

type CardQuestionAttachment = NonNullable<CardQuestion["attachments"]>[number];

const documentText = "# 정리 작업 모음\n\n- 첫째\n- 둘째";
const documentDescriptor = {
  attachment_id: "doc-1",
  name: "정리 작업 모음.md",
  mime_type: "text/markdown",
  byte_size: new TextEncoder().encode(documentText).byteLength,
  checksum_sha256: null,
  width: null,
  height: null,
  preview_kind: "text" as const,
  preview_mime_type: "text/markdown",
};
const documentPreview = "/api/attachments/doc-1/content?context_type=card&context_id=card-1";
const documentAttachment: CardQuestionAttachment = {
  type: "link",
  label: "미리 해 둘 정리 작업 모음",
  url: `${documentPreview}&download=true`,
  attachment_id: "doc-1",
  descriptor: documentDescriptor,
  read_context: { type: "card", id: "card-1" },
  previewUrl: documentPreview,
  originalUrl: `${documentPreview}&download=true`,
};
const imageAttachment: CardQuestionAttachment = {
  type: "image",
  label: "지금 실행 명령에 보이는 모습",
  url: "/api/attachments/image-1/content?context_type=card&context_id=card-1",
  attachment_id: "image-1",
  descriptor: {
    attachment_id: "image-1",
    name: "화면.png",
    mime_type: "image/png",
    byte_size: 512,
    checksum_sha256: null,
    width: 20,
    height: 10,
    preview_kind: "image",
    preview_mime_type: "image/png",
  },
  read_context: { type: "card", id: "card-1" },
  previewUrl: "/api/attachments/image-1/content?context_type=card&context_id=card-1",
  originalUrl: "/api/attachments/image-1/content?context_type=card&context_id=card-1&download=true",
};

function view(attachments: CardQuestionAttachment[]): CardQuestionView {
  return {
    id: "q-1",
    title: "정리 작업을 확인했나요?",
    background: "정리한 문서를 확인해 주세요.",
    kind: "choice",
    options: [{ label: "확인함", description: null, recommended: false }],
    attachments,
    thread: [],
    open: true,
    selectedOption: null,
    answer: null,
    revisedAt: null,
    awaitingAgent: false,
  };
}

function rangeResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, {
    status: 206,
    headers: {
      "Content-Range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens a question document attachment in the shared viewer and blocks navigation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => rangeResponse(documentText)));
  await act(() => root.render(<CardQuestionBody view={view([documentAttachment])} portraitUrl={null} />));

  const link = container.querySelector<HTMLAnchorElement>('[data-evidence-type="link"] a')!;
  expect(link.getAttribute("href")).toBe(documentAttachment.originalUrl);
  expect(link.target).toBe("_blank");

  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    link.dispatchEvent(click);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  expect(click.defaultPrevented).toBe(true);
  const viewer = document.body.querySelector<HTMLElement>(".chat-image-viewer-popup");
  expect(viewer).not.toBeNull();
  expect(viewer?.querySelector(".chat-image-viewer-title")?.textContent).toBe("정리 작업 모음.md");
  await vi.waitFor(() => expect(viewer?.textContent).toContain("정리 작업 모음"));
});

it("keeps question links without attachment metadata as new-tab links", async () => {
  const external: CardQuestionAttachment = { type: "link", label: "바깥 안내", url: "https://example.test/guide" };
  await act(() => root.render(<CardQuestionBody view={view([external])} portraitUrl={null} />));

  const link = container.querySelector<HTMLAnchorElement>('[data-evidence-type="link"] a')!;
  expect(link.target).toBe("_blank");
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(() => { link.dispatchEvent(click); });

  expect(click.defaultPrevented).toBe(false);
  expect(document.body.querySelector(".chat-image-viewer-popup")).toBeNull();
});

it("opens a question image attachment through the shared viewer with its metadata", async () => {
  await act(() => root.render(<CardQuestionBody view={view([imageAttachment])} portraitUrl={null} />));

  const image = container.querySelector<HTMLImageElement>('[data-evidence-type="image"] img')!;
  await act(() => image.click());

  const viewer = document.body.querySelector<HTMLElement>(".chat-image-viewer-popup");
  expect(viewer).not.toBeNull();
  expect(viewer?.querySelector(".chat-image-viewer-title")?.textContent).toBe("화면.png");
  expect(viewer?.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(imageAttachment.previewUrl);
});
