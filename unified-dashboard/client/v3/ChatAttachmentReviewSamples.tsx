import { useEffect, useMemo, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";

const sampleContext = { type: "session" as const, id: "attachment-review-sample" };

function localItem(file: File, previewKind: ChatAttachmentItem["previewKind"]): ChatAttachmentItem {
  return {
    key: `local:${file.name}`,
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
  const [index, setIndex] = useState<number | null>(0);
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

  const openAt = (next: number, trigger: HTMLButtonElement) => {
    setReturnFocus(trigger);
    setIndex(next);
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex flex-wrap gap-2">
        {items.map((item, itemIndex) => (
          <Button key={item.key} variant="outline" onClick={event => openAt(itemIndex, event.currentTarget)}>
            {item.name ?? "첨부 파일"}
          </Button>
        ))}
      </div>
      <AttachmentViewer
        items={items}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        returnFocus={returnFocus}
      />
    </main>
  );
}
