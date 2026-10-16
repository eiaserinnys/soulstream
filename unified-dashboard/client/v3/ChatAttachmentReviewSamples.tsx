import { useEffect, useMemo, useState } from "react";
import { Button, FileAttachmentPreview } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { ChatAttachments } from "@seosoyoung/soul-ui/components/chat/ChatAttachments";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";

const sampleContext = { type: "session" as const, id: "attachment-review-sample" };

function localItem(file: File, previewKind: ChatAttachmentItem["previewKind"], key = `local:${file.name}`): ChatAttachmentItem {
  return {
    key,
    name: file.name,
    mimeType: file.type || null,
    byteSize: file.size,
    previewKind,
    availability: "ready",
    previewUrl: null,
    originalUrl: null,
    legacySources: [],
    source: { kind: "local", file },
  };
}

function reviewImage(key: string, name: string): ChatAttachmentItem {
  return {
    key,
    name,
    mimeType: "image/png",
    byteSize: 4096,
    previewKind: "image",
    availability: "ready",
    previewUrl: "/icon-192.png",
    originalUrl: null,
    legacySources: [],
    source: { kind: "markdown-image", src: "/icon-192.png", alt: name },
  };
}

function failingTextItem(key: string, name: string, path: string): ChatAttachmentItem {
  return {
    key,
    name,
    mimeType: "text/plain",
    byteSize: 1,
    previewKind: "text",
    availability: "ready",
    previewUrl: path,
    originalUrl: null,
    legacySources: [],
    source: { kind: "asset", attachmentId: key, context: sampleContext },
  };
}

export function ChatAttachmentReviewSamples() {
  const items = useMemo(() => {
    const emptyText = new File([], "empty.txt", { type: "text/plain" });
    const largeText = new File([new Uint8Array(1_048_586).fill(65)], "large.txt", { type: "text/plain" });
    const markdown = new File(["# 제목\n\n**강조** · `코드` · <script>문자 그대로</script>"], "readme.md", { type: "text/markdown" });
    const json = new File(['{"attachment":"sample","ready":true}'], "manifest.json", { type: "application/json" });
    const binary = new File([new Uint8Array([0, 1, 2])], "archive.bin", { type: "application/octet-stream" });
    const svg = new File(["<svg></svg>"], "vector.svg", { type: "image/svg+xml" });
    const heic = new File([new Uint8Array([0])], "photo.heic", { type: "image/heic" });
    const missing: ChatAttachmentItem = {
      key: "missing:attachment",
      name: "missing.txt",
      mimeType: "text/plain",
      byteSize: null,
      previewKind: "info",
      availability: "missing",
      previewUrl: null,
      originalUrl: null,
      legacySources: [],
      source: { kind: "unavailable", path: "missing.txt", context: sampleContext },
    };
    const image: ChatAttachmentItem = {
      key: "markdown-image:review",
      name: "sample-image.png",
      mimeType: "image/png",
      byteSize: null,
      previewKind: "image",
      availability: "ready",
      previewUrl: "/icon-192.png",
      originalUrl: null,
      legacySources: [],
      source: { kind: "markdown-image", src: "/icon-192.png", alt: "검수 이미지" },
    };
    return [
      image,
      localItem(emptyText, "text"),
      localItem(largeText, "text"),
      localItem(markdown, "text"),
      localItem(json, "text"),
      localItem(binary, "info"),
      localItem(svg, "info"),
      localItem(heic, "info"),
      failingTextItem("review:403", "permission-denied.txt", "/__review-attachment/403"),
      failingTextItem("review:503", "service-unavailable.txt", "/__review-attachment/503"),
      missing,
    ];
  }, []);
  const chatItems = useMemo(() => {
    const firstNote = localItem(new File(["첫 첨부"], "회의.txt", { type: "text/plain" }), "text", "user-note-one");
    const secondNote = localItem(new File(["다른 내용"], "회의.txt", { type: "text/plain" }), "text", "user-note-two");
    const longArchive = localItem(
      new File([new Uint8Array([1, 2, 3])], "회의자료_아주긴한국어파일이름_최종검토본.zip", { type: "application/zip" }),
      "info",
      "user-long-archive",
    );
    const missing: ChatAttachmentItem = {
      key: "user-missing",
      name: "이전 첨부.txt",
      mimeType: "text/plain",
      byteSize: null,
      previewKind: "info",
      availability: "missing",
      previewUrl: null,
      originalUrl: null,
      legacySources: [],
      source: { kind: "unavailable", path: "이전 첨부.txt", context: sampleContext },
    };
    return {
      user: [reviewImage("user-image-one", "사용자 이미지 1.png"), firstNote, reviewImage("user-image-two", "사용자 이미지 2.png"), secondNote, longArchive, missing],
      assistant: [
        reviewImage("assistant-image", "응답 이미지.png"),
        localItem(new File(['{"ok":true}'], "manifest.json", { type: "application/json" }), "text", "assistant-json"),
      ],
      tile: new File(["기존 타일 표본"], "existing-attachment.pdf", { type: "application/pdf" }),
    };
  }, []);
  const [index, setIndex] = useState<number | null>(null);
  const [viewerItems, setViewerItems] = useState(items);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const originalFetch = window.fetch;
    const reviewFetch: typeof window.fetch = (input, init) => {
      const url = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
      if (url.endsWith("/__review-attachment/403")) return Promise.resolve(new Response(null, { status: 403 }));
      if (url.endsWith("/__review-attachment/503")) return Promise.resolve(new Response(null, { status: 503 }));
      return originalFetch.call(window, input, init);
    };
    window.fetch = reviewFetch;
    return () => {
      if (window.fetch === reviewFetch) window.fetch = originalFetch;
    };
  }, []);

  const openAt = (sourceItems: ChatAttachmentItem[], next: number, trigger: HTMLElement) => {
    setViewerItems(sourceItems);
    setReturnFocus(trigger);
    setIndex(next);
  };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6">
      <div className="flex flex-col gap-4">
        <section>
          <p className="text-sm text-muted-foreground">사용자</p>
          <ChatAttachments items={chatItems.user} role="user" onOpen={(next, trigger) => openAt(chatItems.user, next, trigger)} />
        </section>
        <section>
          <p className="text-sm text-muted-foreground">Assistant</p>
          <ChatAttachments items={chatItems.assistant} role="assistant" onOpen={(next, trigger) => openAt(chatItems.assistant, next, trigger)} />
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">기존 첨부 타일</p>
          <div className="flex gap-2">
            <FileAttachmentPreview file={chatItems.tile} status="done" onRemove={() => {}} />
          </div>
        </section>
        <div className="flex flex-wrap gap-2">
          {items.map((item, itemIndex) => (
            <Button key={item.key} variant="outline" onClick={event => openAt(items, itemIndex, event.currentTarget)}>
              {item.name ?? "첨부 파일"}
            </Button>
          ))}
        </div>
      </div>
      <AttachmentViewer
        items={viewerItems}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        returnFocus={returnFocus}
      />
    </main>
  );
}
