import { useLayoutEffect, useMemo, useState } from "react";
import { ChatUiControllerProvider, FileAttachmentPreview } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { ChatAttachments } from "@seosoyoung/soul-ui/components/chat/ChatAttachments";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { ToolCallGroup } from "@seosoyoung/soul-ui/components/chat/ToolCallGroup";
import { UserMessage } from "@seosoyoung/soul-ui/components/chat/UserMessage";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { ChatInputAccessories } from "@seosoyoung/soul-ui/components/chat/ChatInputAccessories";
import { ChatInputComposer } from "@seosoyoung/soul-ui/components/chat/ChatInputComposer";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import { projectChatAttachmentItems, type ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { projectChatOutputAttachments } from "@seosoyoung/soul-ui/lib/chat-output-attachment-projection";
import { reviewDocuments } from "./chat-ui-review-documents";
import "./components-review.css";

type SessionEventAttachmentResponse = Parameters<typeof projectChatAttachmentItems>[0];
type SessionEventAttachmentView = SessionEventAttachmentResponse["items"][number];

const sampleContext = { type: "session" as const, id: "attachment-review-sample" };
const connectedReviewSessionId = "attachment-review-connected";
const overlayReviewSessionId = "attachment-review-overlay";

function decodeReviewMediaBytes(base64: string): ArrayBuffer {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

function connectedAsset(
  attachmentId: string,
  name: string,
  mimeType: string,
  previewKind: "image" | "text" | "info",
  sessionId: string,
  byteSize: number = 4096,
): SessionEventAttachmentView {
  return {
    kind: "asset",
    descriptor: {
      attachment_id: attachmentId,
      name,
      mime_type: mimeType,
      byte_size: byteSize,
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
      connectedAsset("review-failed-image", "누락 이미지.png", "image/png", "image", sessionId),
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
    208: [connectedAsset("review-large-text", "큰_텍스트.txt", "text/plain", "text", sessionId, 1_048_586)],
    209: [connectedAsset("review-assistant-truncated", "응답 전문.txt", "text/plain", "text", sessionId, 1_048_586)],
    301: [connectedAsset("review-output-image", "응답 이미지.png", "image/png", "image", sessionId)],
    302: [connectedAsset("review-output-image", "응답 이미지.png", "image/png", "image", sessionId)],
    304: [connectedAsset("review-complete-only", "완료 첨부.txt", "text/plain", "text", sessionId)],
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
    const sampleVideo = new File([decodeReviewMediaBytes("AAAAIGZ0eXBtcDQyAAACAG1wNDJpc28yYXZjMW1wNDEAAAMMbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjd0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGvbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABWm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARpzdGJsAAAAtnN0c2QAAAAAAAAAAQAAAKZhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALGF2Y0MBQsAK/+EAFWdCwAraewEQAAADABAAAAMAKPEiagEABGjOD8gAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAATKAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACZQAAAAEAAAAUc3RjbwAAAAAAAAABAAADPAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDMAAAAIZnJlZQAAAm1tZGF0AAACUwYF//9P3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAKZYiEOiYoAAkC4A==")], "sample-video.mp4", { type: "video/mp4" });
    const sampleAudioMp3 = new File([decodeReviewMediaBytes("SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAADAAABsACqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dX///////////////////////////////////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJARRAAAAAAAAAbD3Cij+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/4xjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/4xjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=")], "sample-audio.mp3", { type: "audio/mpeg" });
    const sampleAudioWav = new File([new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x25, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x01, 0x00, 0x00, 0x00, 0x80,
    ])], "sample-audio.wav", { type: "audio/wav" });
    const sampleAudioFlac = new File([decodeReviewMediaBytes("ZkxhQwAAACICQAJAAAALAAAMAfQA8AAAAyBq0A9H2K1PEgBbIrLKpI94hAAALAwAAABMYXZmNjEuNy4xMDMBAAAAFAAAAGVuY29kZXI9TGF2ZjYxLjcuMTAz//gkCADKAAAAznb/+GQIAd/lAAAAzwo=")], "sample-audio.flac", { type: "audio/flac" });
    const longMarkdownSections = Array.from({ length: 14 }, (_, index) => [
      `## 절 ${index + 1}`,
      "",
      `이 절의 본문은 긴 문서에서 표와 코드 블록의 높이가 유지되는지 확인합니다. ${"긴 설명이 패널 아래까지 이어집니다. ".repeat(12)}`,
    ].join("\n"));
    const markdown = new File([[
      "# 톤 제안 원문",
      "",
      "## 선택 방향",
      "",
      "- 명확한 제목",
      "- 짧은 설명",
      "",
      "| 항목 | 상태 | 비고 |",
      "| --- | --- | --- |",
      "| 미리보기 | 준비 | 긴 문서 표본 |",
      "| Markdown | 문서 레이아웃 | 코드 블록 포함 |",
      "| 좁은 화면 | 확인 대상 | 줄바꿈 포함 |",
      "",
      "## 세부 점검",
      "",
      "| 화면 | 폭 | 확인 내용 |",
      "| --- | --- | --- |",
      "| 넓은 화면 | 1440 | 표와 코드 블록 높이 |",
      "| 좁은 화면 | 390 | 내용과 스크롤 |",
      "| 다크 테마 | 390 | 본문 대비 |",
      "",
      "```ts",
      "const tone = 'Argon';",
      "export function pick(level: number) { return level > 2 ? 'bold' : 'calm'; }",
      "```",
      "",
      ...longMarkdownSections,
      "",
      "",
      "[참고 링크](https://example.com)",
    ].join("\n")], "톤 제안 원문.md", { type: "text/markdown" });
    const html = new File([[
      "<!doctype html>",
      "<html><head><meta charset='utf-8'><style>",
      "body { font-family: sans-serif; }",
      ".modal { display: none; position: fixed; inset: 0; place-items: center; background: rgba(0, 0, 0, .7); }",
      ".modal[aria-hidden='false'] { display: grid; }",
      ".modal-card { padding: 1.5em; background: white; color: #111; }",
      "</style></head><body>",
      "<h1>보고서 시안</h1>",
      "<p>샌드박스 안에서 모달 조작을 확인합니다.</p>",
      "<button id='open-modal' type='button'>모달 열기</button>",
      "<div class='modal' id='modal' role='dialog' aria-modal='true' aria-hidden='true'><div class='modal-card'><p>보고서 모달</p><button id='close-modal' type='button'>닫기</button></div></div>",
      "<script>",
      "const modal = document.getElementById('modal');",
      "document.getElementById('open-modal').addEventListener('click', () => modal.setAttribute('aria-hidden', 'false'));",
      "document.getElementById('close-modal').addEventListener('click', () => modal.setAttribute('aria-hidden', 'true'));",
      "</script></body></html>",
    ].join("\n")], "보고서 시안.html", { type: "text/html" });
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
      localItem(sampleVideo, "info"),
      localItem(sampleAudioMp3, "info"),
      localItem(sampleAudioWav, "info"),
      localItem(sampleAudioFlac, "info"),
      localItem(emptyText, "text"),
      localItem(largeText, "text"),
      localItem(markdown, "text"),
      localItem(html, "text"),
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
      content: "일반 채팅의 첨부입니다.\n\n[보고서](/api/attachments/review-chat-markdown/content?context_type=session&context_id=attachment-review-connected)\n\n![첨부 행과 같은 이미지](/api/attachments/review-user-image/content?context_type=session&context_id=attachment-review-connected)\n\n본문 설명 ![외부 이미지](https://images.example/ordinary.png) 뒤 설명\n\n![이전 경로](/api/attachments/files?nodeId=eiaserinnys&path=%2Fincoming%2Finline-only.png)",
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
      content: "PAS 사용자 첨부입니다.\n\n![첨부 행과 같은 이미지](/api/attachments/review-manuscript-image/content?context_type=session&context_id=attachment-review-connected)",
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
      id: "connected-large-text",
      role: "assistant",
      content: "앞부분만 확인하고 원본 전체를 저장할 수 있는 큰 텍스트 첨부입니다.",
      treeNodeId: "connected-large-text",
      treeNodeType: "assistant_message",
      eventId: 208,
      attachmentIds: ["review-large-text"],
    },
    {
      id: "connected-error-401",
      role: "user",
      content: "로그인이 필요한 첨부입니다.",
      treeNodeId: "connected-error-401",
      treeNodeType: "user_message",
      eventId: 401,
      attachmentIds: ["review-login-required"],
    },
    {
      id: "connected-error-404",
      role: "user",
      content: "찾을 수 없는 첨부입니다.",
      treeNodeId: "connected-error-404",
      treeNodeType: "user_message",
      eventId: 404,
      attachmentIds: ["review-not-found"],
    },
    {
      id: "connected-error-403",
      role: "user",
      content: "권한이 없는 첨부입니다.",
      treeNodeId: "connected-error-403",
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
    {
      id: "connected-user-temporary-failure",
      role: "user",
      content: "일시 실패 상태입니다.",
      treeNodeId: "connected-user-temporary-failure",
      treeNodeType: "user_message",
      eventId: 503,
      attachmentIds: ["review-temporary-failure"],
    },
  ] as ChatMessage[], [connectedUi]);
  const truncationSamples = useMemo(() => {
    const toolAttachment = (attachmentId: string, name: string) => ({
      attachment_id: attachmentId,
      name,
      mime_type: "text/plain",
      byte_size: 1_048_586,
      checksum_sha256: null,
      width: null,
      height: null,
      preview_kind: "text" as const,
      preview_mime_type: "text/plain",
    });
    const singleAttachment = toolAttachment("review-tool-single-full", "도구 결과 전문.txt");
    const groupInputAttachment = toolAttachment("review-tool-group-input-full", "도구 입력 전문.txt");
    const groupAttachment = toolAttachment("review-tool-group-full", "도구 결과 전문.txt");
    const assistantAttachment = toolAttachment("review-assistant-truncated", "응답 전문.txt");
    const thinkingAttachment = toolAttachment("review-thinking-full", "생각 전문.txt");
    return {
      single: {
        id: "truncation-single-tool",
        role: "tool",
        content: "Read · 완료",
        treeNodeId: "truncation-single-tool",
        treeNodeType: "tool",
        toolName: "Read",
        toolResult: "첫 부분\n[잘림]",
        toolResultTruncation: { original_bytes: 1_048_586, attachment: singleAttachment },
        eventId: 501,
        fullContentEventId: 501,
      } as ChatMessage,
      group: [
        {
          id: "truncation-group-tool",
          role: "tool",
          content: "Read · 완료",
          treeNodeId: "truncation-group-tool",
          treeNodeType: "tool",
          toolName: "Read",
          toolInput: "입력 첫 부분\n[잘림]",
          toolInputTruncation: { original_bytes: 409_600, attachment: groupInputAttachment },
          toolResult: "첫 부분\n[잘림]",
          toolResultTruncation: { original_bytes: 1_048_586, attachment: groupAttachment },
          eventId: 502,
          fullContentEventId: 502,
        },
        {
          id: "truncation-group-tool-next",
          role: "tool",
          content: "Search · 완료",
          treeNodeId: "truncation-group-tool-next",
          treeNodeType: "tool",
          toolName: "Search",
          toolResult: "찾은 결과",
          eventId: 503,
        },
      ] as ChatMessage[],
      failed: {
        id: "truncation-failed-tool",
        role: "tool",
        content: "Fetch · 완료",
        treeNodeId: "truncation-failed-tool",
        treeNodeType: "tool",
        toolName: "Fetch",
        toolResult: "첫 부분\n[잘림]",
        toolResultTruncation: { original_bytes: 900_000, attachment: null },
        eventId: 504,
      } as ChatMessage,
      assistant: {
        id: "truncation-assistant",
        role: "assistant",
        content: "응답 첫 부분\n[잘림]",
        treeNodeId: "truncation-assistant",
        treeNodeType: "assistant_message",
        eventId: 209,
        attachmentIds: ["review-assistant-truncated"],
        truncation: { original_bytes: 1_048_586, attachment: assistantAttachment },
      } as ChatMessage,
      thinking: {
        id: "truncation-thinking",
        role: "assistant",
        content: "생각 첫 부분\n[잘림]",
        thinkingContent: "생각 첫 부분\n[잘림]",
        treeNodeId: "truncation-thinking",
        treeNodeType: "thinking",
        eventId: 505,
        truncation: { original_bytes: 512_000, attachment: thinkingAttachment },
      } as ChatMessage,
    };
  }, []);
  const projectedOutputMessages = useMemo(() => projectChatOutputAttachments([
    {
      id: "review-output-response",
      role: "assistant",
      content: "응답과 함께 전달된 파일입니다.",
      treeNodeId: "review-output-response",
      treeNodeType: "assistant_message",
      eventId: 301,
      attachmentIds: ["review-output-image"],
    },
    {
      id: "review-output-complete-1",
      role: "system",
      content: "완료",
      treeNodeId: "review-output-complete-1",
      treeNodeType: "complete",
      eventId: 302,
      attachmentIds: ["review-output-image"],
      captionStats: "턴 비용 $0.04",
    },
    {
      id: "review-output-generation-2",
      role: "system",
      content: "새 세대",
      treeNodeId: "review-output-generation-2",
      treeNodeType: "generation_started",
      eventId: 303,
    },
    {
      id: "review-output-complete-2",
      role: "system",
      content: "완료",
      treeNodeId: "review-output-complete-2",
      treeNodeType: "complete",
      eventId: 304,
      attachmentIds: ["review-complete-only"],
      captionStats: "턴 비용 $0.03",
    },
  ] as ChatMessage[]), []);
  const [index, setIndex] = useState<number | null>(null);
  const [viewerItems, setViewerItems] = useState(items);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState("첨부를 취소해도 이 초안은 남습니다.");
  const [pendingFiles, setPendingFiles] = useState(() => [
    { id: "ready", file: new File(["완료"], "회의자료_고객요청사항_최종검토본.pdf", { type: "application/pdf" }), status: "done" as const },
    { id: "uploading", file: new File(["업로드"], "화면설계_첨부_버튼과_프리뷰_수정본.pdf", { type: "application/pdf" }), status: "uploading" as const },
    { id: "error", file: new File(["실패"], "번역검토_세부원문_수정요청_목록.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), status: "error" as const },
  ]);
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  useLayoutEffect(() => {
    let active = true;
    void fetch("/icon-192.png").then(response => response.blob()).then(blob => {
      if (active) setPastedImage(new File([blob], "clipboard-review.png", { type: "image/png" }));
    });
    return () => { active = false; };
  }, []);
  const pendingItems = useMemo(() => pendingFiles.map(({ id, file }) => localItem(file, "info", `pending:${id}`)), [pendingFiles]);
  const attachmentOnlyFile = useMemo(() => new File(["자료"], "답변에_포함할_추가_자료.pdf", { type: "application/pdf" }), []);
  const attachmentOnlyItems = useMemo(() => [localItem(attachmentOnlyFile, "info", "attachment-only")], [attachmentOnlyFile]);

  useLayoutEffect(() => {
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
        const requestAttribute = "data-review-event-" + eventId + "-requests";
        const requestCount = Number(document.documentElement.getAttribute(requestAttribute) ?? "0") + 1;
        document.documentElement.setAttribute(requestAttribute, String(requestCount));
        if (eventId === 401) return Promise.resolve(new Response(null, { status: 401 }));
        if (eventId === 403) return Promise.resolve(new Response(null, { status: 403 }));
        if (eventId === 404) return Promise.resolve(new Response(null, { status: 404 }));
        if (eventId === 503) return Promise.resolve(new Response(null, { status: 503 }));
        if (sessionId === connectedReviewSessionId || sessionId === overlayReviewSessionId) {
          return Promise.resolve(new Response(JSON.stringify(connectedProjection(eventId, sessionId)), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
      }
      const attachmentMetadata = url.match(/^\/api\/attachments\/(review-chat-markdown)(?:\?|$)/);
      if (attachmentMetadata) {
        return Promise.resolve(Response.json({
          descriptor: {
            attachment_id: attachmentMetadata[1],
            name: "채팅 보고서.md",
            mime_type: "text/markdown",
            checksum_sha256: null,
            byte_size: new TextEncoder().encode("# 채팅 첨부 미리보기\n\n검수 창의 일반 채팅 링크입니다.").byteLength,
            width: null,
            height: null,
            preview_kind: "text",
            preview_mime_type: "text/markdown",
          },
          upload_status: "committed",
        }));
      }
      const attachmentContent = url.match(/^\/api\/attachments\/review-chat-markdown\/content(?:\?|$)/);
      if (attachmentContent) {
        const bytes = new TextEncoder().encode("# 채팅 첨부 미리보기\n\n검수 창의 일반 채팅 링크입니다.");
        const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), bytes.byteLength - 1);
          const content = bytes.slice(start, end + 1);
          return Promise.resolve(new Response(content, {
            status: 206,
            headers: {
              "content-range": `bytes ${start}-${end}/${bytes.byteLength}`,
              "content-length": String(content.byteLength),
              "content-type": "text/markdown",
            },
          }));
        }
        return Promise.resolve(new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength), "content-type": "text/markdown" },
        }));
      }
      const fullContentRequest = url.match(/^\/api\/attachments\/(review-tool-single-full|review-tool-group-full|review-tool-group-input-full|review-thinking-full|review-assistant-truncated)\/content(?:\?|$)/);
      if (fullContentRequest) {
        const byteSize = 1_048_586;
        if (init?.method === "HEAD") {
          return Promise.resolve(new Response(null, {
            status: 200,
            headers: { "content-length": String(byteSize) },
          }));
        }
        const bytes = new Uint8Array(byteSize).fill(65);
        bytes.set(new TextEncoder().encode(`${fullContentRequest[1]} 전문\n`));
        const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(range?.[1] ?? 0);
        const end = Math.min(Number(range?.[2] ?? (byteSize - 1)), byteSize - 1);
        const content = bytes.slice(start, end + 1);
        return Promise.resolve(new Response(content, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${byteSize}`,
            "Content-Length": String(content.byteLength),
          },
        }));
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

  const pendingChips = <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{pendingFiles.map(file => (
    <FileAttachmentPreview key={file.id} variant="chip" file={file.file} status={file.status}
      onOpen={(next, trigger) => { const itemIndex = pendingItems.findIndex(item => item.source.kind === "local" && item.source.file === next); if (itemIndex >= 0) openAt(pendingItems, itemIndex, trigger); }}
      onRemove={() => setPendingFiles(current => current.filter(item => item.id !== file.id))} />
  ))}{pastedImage && <FileAttachmentPreview variant="chip" file={pastedImage} status="done"
    onOpen={(file, trigger) => openAt([localItem(file, "image")], 0, trigger)} onRemove={() => setPastedImage(null)} />}</div>;
  const attachmentOnlyChip = <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
    <FileAttachmentPreview variant="chip" file={attachmentOnlyFile} status="done"
      onOpen={(_, trigger) => openAt(attachmentOnlyItems, 0, trigger)} onRemove={() => {}} />
  </div>;

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
          <section className="flex flex-col gap-2" aria-label="응답 출력과 완료 캡션">
            <div className="v3-type-section">응답 출력과 완료 캡션</div>
            <div className="v3-chat-surface flex flex-col">
              {projectedOutputMessages.map((msg) => (
                <ChatMessageItem key={msg.treeNodeId} msg={msg} sessionId={connectedReviewSessionId} />
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-2" aria-label="잘린 이벤트 전문 연결">
            <div className="v3-type-section">잘린 이벤트와 전문</div>
            <div className="v3-chat-surface flex flex-col">
              <ChatMessageItem msg={truncationSamples.single} sessionId={connectedReviewSessionId} />
              <ToolCallGroup
                messages={truncationSamples.group}
                sessionId={connectedReviewSessionId}
                expanded
              />
              <ChatMessageItem msg={truncationSamples.failed} sessionId={connectedReviewSessionId} />
              <ChatMessageItem msg={truncationSamples.thinking} sessionId={connectedReviewSessionId} />
              <ChatMessageItem msg={truncationSamples.assistant} sessionId={connectedReviewSessionId} />
              <ChatMessageItem msg={{
                id: "legacy-thinking-full-content-review",
                role: "assistant",
                content: "이전 전문 열기 동작",
                thinkingContent: "이전 전문 열기 동작",
                treeNodeId: "legacy-thinking-full-content-review",
                treeNodeType: "thinking",
                eventId: 505,
                fullContentEventId: 505,
                isTruncated: true,
              } as ChatMessage} sessionId={connectedReviewSessionId} />
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
        <section className="flex flex-col gap-2" aria-label="대기 중인 첨부와 초안">
          <div className="v3-type-section">대기 중인 첨부 · 초안</div>
          <ChatInputAccessories attachments={pendingChips} />
          <ChatInputComposer>
            <ChatInputEditor text={draft} onChangeText={setDraft} onSend={() => {}} placeholder="" buttonLabel="전송" modeIcon="" modeLabel="" borderColor="" buttonVariant="default" disabled={pendingFiles.some(file => file.status !== "done")} textareaDisabled={false} />
          </ChatInputComposer>
        </section>
        <section className="flex flex-col gap-2" aria-label="첨부만 전송">
          <div className="v3-type-section">첨부만 전송</div>
          <ChatInputAccessories attachments={attachmentOnlyChip} />
          <ChatInputComposer>
            <ChatInputEditor text="" onChangeText={() => {}} onSend={() => {}} placeholder="" buttonLabel="전송" modeIcon="" modeLabel="" borderColor="" buttonVariant="default" disabled={false} textareaDisabled={false} />
          </ChatInputComposer>
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
