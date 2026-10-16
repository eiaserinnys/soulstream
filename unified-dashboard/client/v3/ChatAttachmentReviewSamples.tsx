import { useEffect, useMemo, useState } from "react";
import { ChatUiControllerProvider, FileAttachmentPreview } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { ChatAttachments } from "@seosoyoung/soul-ui/components/chat/ChatAttachments";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { SessionEventAttachmentResponse, SessionEventAttachmentView } from "@soulstream/wire-schema/attachments";
import { reviewDocuments } from "./chat-ui-review-documents";
import "./components-review.css";

const sampleContext = { type: "session" as const, id: "attachment-review-sample" };
const connectedReviewSessionId = "attachment-review-connected";
const overlayReviewSessionId = "attachment-review-overlay";

function connectedAsset(
  attachmentId: string,
  name: string,
  mimeType: string,
  previewKind: "image" | "text" | "info",
  sessionId: string,
): SessionEventAttachmentView {
  return {
    kind: "asset",
    descriptor: {
      attachment_id: attachmentId,
      name,
      mime_type: mimeType,
      byte_size: 4096,
      checksum_sha256: null,
      width: previewKind === "image" ? 1 : null,
      height: previewKind === "image" ? 1 : null,
      preview_kind: previewKind,
      preview_mime_type: previewKind === "image" ? mimeType : null,
    },
    read_context: { type: "session", id: sessionId },
    legacy_sources: [],
  };
}

function connectedProjection(eventId: number, sessionId: string): SessionEventAttachmentResponse {
  const itemsByEvent: Record<number, SessionEventAttachmentView[]> = {
    201: [
      connectedAsset("review-user-image", "사용자 이미지.png", "image/png", "image", sessionId),
      connectedAsset("review-user-archive", "자료.zip", "application/zip", "info", sessionId),
      {
        kind: "legacy",
        node_id: "eiaserinnys",
        path: "/incoming/참고.txt",
        name: "참고.txt",
        mime_type: "text/plain",
        byte_size: 20,
        availability: "unresolved",
        read_context: { type: "session", id: sessionId },
      },
    ],
    202: [
      connectedAsset("review-output-image", "응답 이미지.png", "image/png", "image", sessionId),
      connectedAsset("review-output-note", "응답.txt", "text/plain", "text", sessionId),
    ],
    203: [connectedAsset("review-rich-file", "요약.json", "application/json", "text", sessionId)],
    204: [connectedAsset("review-manuscript-image", "PAS 사용자 이미지.png", "image/png", "image", sessionId)],
    205: [connectedAsset("review-manuscript-output", "PAS 응답.txt", "text/plain", "text", sessionId)],
    206: [connectedAsset("review-intervention-file", "개입 첨부.txt", "text/plain", "text", sessionId)],
    207: [connectedAsset("review-overlay-file", "선택 카드 자료.txt", "text/plain", "text", sessionId)],
  };
  return { event_id: eventId, items: itemsByEvent[eventId] ?? [] };
}

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
  const { chatTypographyStyle } = useChatTypography();
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
        {
          ...reviewImage("assistant-failed-image", "불러오지 못한 이미지.png"),
          previewUrl: "/__review-attachment/missing.png",
          source: { kind: "markdown-image", src: "/__review-attachment/missing.png", alt: "불러오지 못한 이미지" },
        } satisfies ChatAttachmentItem,
        ...items.slice(1),
      ],
      tile: new File(["기존 타일 표본"], "existing-attachment.pdf", { type: "application/pdf" }),
    };
  }, [items]);
  const connectedUi = useMemo(() => ({
    schema_version: 1,
    revision: 1,
    ui_id: `ui_${"b".repeat(32)}`,
    hash: "c".repeat(64),
    document: reviewDocuments.normal,
  }), []);
  const connectedMessages = useMemo(() => [
    {
      id: "connected-default-user",
      role: "user",
      content: "일반 채팅의 첨부입니다.",
      treeNodeId: "connected-default-user",
      treeNodeType: "user_message",
      eventId: 201,
      attachmentIds: ["review-user-image", "review-user-archive"],
      attachmentPaths: ["/incoming/참고.txt"],
    },
    {
      id: "connected-textless-output",
      role: "assistant",
      content: "",
      treeNodeId: "connected-textless-output",
      treeNodeType: "assistant_message",
      eventId: 202,
      attachmentIds: ["review-output-image", "review-output-note"],
    },
    {
      id: "connected-rich-output",
      role: "assistant",
      content: "표본 문서",
      treeNodeId: "connected-rich-output",
      treeNodeType: "assistant_message",
      eventId: 203,
      attachmentIds: ["review-rich-file"],
      ui: connectedUi,
    },
    {
      id: "connected-manuscript-user",
      role: "user",
      content: "PAS 사용자 첨부입니다.",
      treeNodeId: "connected-manuscript-user",
      treeNodeType: "user_message",
      eventId: 204,
      attachmentIds: ["review-manuscript-image"],
    },
    {
      id: "connected-manuscript-output",
      role: "assistant",
      content: "PAS 응답 첨부입니다.",
      treeNodeId: "connected-manuscript-output",
      treeNodeType: "assistant_message",
      eventId: 205,
      attachmentIds: ["review-manuscript-output"],
    },
    {
      id: "connected-intervention",
      role: "intervention",
      content: "개입 메시지 첨부입니다.",
      treeNodeId: "connected-intervention",
      treeNodeType: "intervention",
      eventId: 206,
      attachmentIds: ["review-intervention-file"],
    },
    {
      id: "connected-forbidden",
      role: "user",
      content: "권한이 없는 첨부입니다.",
      treeNodeId: "connected-forbidden",
      treeNodeType: "user_message",
      eventId: 403,
      attachmentIds: ["review-forbidden"],
    },
    {
      id: "connected-temporary-failure",
      role: "assistant",
      content: "일시 실패 상태입니다.",
      treeNodeId: "connected-temporary-failure",
      treeNodeType: "assistant_message",
      eventId: 503,
      attachmentIds: ["review-temporary-failure"],
    },
  ] as ChatMessage[], [connectedUi]);
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
      const eventRequest = url.match(/\/api\/sessions\/([^/]+)\/events\/(\d+)\/attachments$/);
      if (eventRequest) {
        const sessionId = decodeURIComponent(eventRequest[1]!);
        const eventId = Number(eventRequest[2]);
        if (eventId === 403) return Promise.resolve(new Response(null, { status: 403 }));
        if (eventId === 503) return Promise.resolve(new Response(null, { status: 503 }));
        if (sessionId === connectedReviewSessionId || sessionId === overlayReviewSessionId) {
          return Promise.resolve(new Response(JSON.stringify(connectedProjection(eventId, sessionId)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
      }
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
    <main className="v3-components-main glass-strong glass-chrome" style={chatTypographyStyle}>
      <div className="flex flex-col gap-4">
        <ChatUiControllerProvider sessionId={connectedReviewSessionId}>
          <section className="flex flex-col gap-2" aria-label="실제 메시지 첨부 연결">
            <div className="v3-type-section">연결된 메시지</div>
            <div className="v3-chat-surface flex flex-col">
              {connectedMessages.map((msg) => (
                <ChatMessageItem
                  key={msg.treeNodeId}
                  msg={msg}
                  sessionId={connectedReviewSessionId}
                  presentation={msg.treeNodeId.includes("manuscript") ? "manuscript" : "default"}
                />
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-2" aria-label="다른 세션 첨부 문맥">
            <div className="v3-type-section">선택 카드 대화 문맥</div>
            <div className="v3-chat-surface flex flex-col">
              <ChatMessageItem
                msg={{
                  id: "connected-overlay-output",
                  role: "user",
                  content: "선택 카드 문맥의 첨부입니다.",
                  treeNodeId: "connected-overlay-output",
                  treeNodeType: "user_message",
                  eventId: 207,
                  attachmentIds: ["review-overlay-file"],
                }}
                sessionId={overlayReviewSessionId}
              />
            </div>
          </section>
        </ChatUiControllerProvider>
        <section>
          <UserMessage msg={{ id: "attachment-review-user", role: "user", treeNodeId: "attachment-review-user", treeNodeType: "user_message", content: "첨부 파일을 확인해 주세요." }} presentation="manuscript">
            <p>첨부 파일을 확인해 주세요.</p>
            <ChatAttachments items={chatItems.user} role="user" onOpen={(next, trigger) => openAt(chatItems.user, next, trigger)} />
          </UserMessage>
        </section>
        <section>
          <AssistantMessage msg={{ id: "attachment-review-assistant", role: "assistant", treeNodeId: "attachment-review-assistant", treeNodeType: "assistant_message", content: "첨부 파일입니다." }} presentation="manuscript">
            <p>첨부 파일입니다.</p>
            <ChatAttachments items={chatItems.assistant} role="assistant" onOpen={(next, trigger) => openAt(chatItems.assistant, next, trigger)} />
          </AssistantMessage>
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">기존 첨부 타일</p>
          <div className="flex gap-2">
            <FileAttachmentPreview file={chatItems.tile} status="done" onRemove={() => {}} />
          </div>
        </section>
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
