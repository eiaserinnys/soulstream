import "../client/globals.css";
import "../client/v3/v3-visual-system.css";
import "../client/v3/v3-card-check-items.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardImageViewer } from "../client/v3/CardImageViewer";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { FileAttachmentPreview } from "@seosoyoung/soul-ui/components/FileAttachmentPreview";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "@seosoyoung/soul-ui";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const width = Number(params.get("width") ?? 800);
const height = Number(params.get("height") ?? 600);
const svg = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="steelblue"/><text x="12" y="40" fill="white" font-size="24">${w} × ${h}</text></svg>`;
const image = svg(width, height);
const sampleSrc = params.get("sample") === "dark" ? "/image-viewer-screen.png"
  : params.get("sample") === "bright" ? "/e2e/fixtures/image-viewer-bright.png" : null;
const src = sampleSrc ?? "data:image/svg+xml," + encodeURIComponent(image);
const file = new File([sampleSrc ? await fetch(sampleSrc).then(response => response.blob()) : image],
  sampleSrc ? "screen.png" : "fixture.svg", {type:sampleSrc ? "image/png" : "image/svg+xml"});
// 검수 반려 2: 320보다 좁은 동영상도 단독 창에서 가운데에 서는지 재는 표본.
const narrowVideo = new File([await fetch("/e2e/fixtures/sample-video.mp4").then(response => response.blob())],
  "sample-video.mp4", {type:"video/mp4"});
const caption = params.get("caption") === "none" ? "" : params.get("caption") === "long"
  ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(5)
  : params.get("caption") === "one" ? "화면 캡처"
  : params.get("caption") === "small-long" ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(3)
  : params.get("caption") === "forty-three" ? "원본 화면의 글자와 배치를 확인하는 이미지입니다. 화면 상태와 설명을 봅니다."
  : params.get("caption") === "two" ? "192 이미지의 상태와 배치를 확인합니다."
  : params.get("caption") === "three"
  ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(2)
  : "첫 번째 설명 줄\n두 번째 설명 줄\n세 번째 설명 줄";

// 카드 #1289: 보기 창이 내용 종류에 맞춰 크기를 잡는지 재는 표본. 긴 문서는 실제
// 기획 문서만 한 40KB 안팎으로 만들고, 표·목록·인라인 코드를 함께 넣는다.
const longDocument = [
  "# 미리 해 둘 정리 작업 모음",
  "",
  "문서 보기 창의 폭과 높이를 재는 표본입니다. 줄이 길어도 읽기 폭 안에서 접힙니다.",
  "",
  "## 남은 일",
  "",
  "- 첫째: 문서 보기 창의 폭이 읽기 폭을 넘지 않는지 확인합니다.",
  "- 둘째: 긴 문서가 창 안에서 스크롤되는지 확인합니다.",
  "- 셋째: 표가 넓어도 표 상자 안에서만 가로로 스크롤되는지 확인합니다.",
  "",
  "| 항목 | 담당 | 상태 | 다음 | 비고 |",
  "| --- | --- | --- | --- | --- |",
  "| 문서 폭 | 로젤린 | 확인 | 읽기 폭 유지 | 아주 긴 셀 내용이 들어가도 표 상자 안에서만 가로로 스크롤합니다 |",
  "| 문서 높이 | 로젤린 | 확인 | 창 안 스크롤 | 내용이 화면보다 길면 창 높이가 화면 한도에서 멈추고 본문이 안에서 스크롤합니다 |",
  `| 긴 해시 | 로젤린 | 확인 | 표 상자 스크롤 | ${"0123456789abcdef".repeat(12)} |`,
  "",
  "인라인 코드는 `pnpm --dir unified-dashboard test`처럼 한 줄에 들어가야 합니다.",
  "",
  ...Array.from({length: 90}, (_, index) => [
    `## 절 ${index + 1}`,
    "",
    `본문 ${index + 1}. 이 문단은 문서 보기 창이 화면 높이에서 멈추고 본문이 안에서 스크롤되는지 확인하기 위한 것입니다. `
      + "문장이 길어도 창 폭을 넘지 않고, 줄바꿈은 읽기 폭 안에서 일어납니다. 표와 목록이 섞여 있어도 같은 규칙을 지킵니다.",
    "",
    `- 항목 ${index + 1}-1`,
    `- 항목 ${index + 1}-2`,
    "",
  ]).flat(),
].join("\n");
const shortDocument = [
  "## 짧은 문서",
  "",
  "몇 줄짜리 문서입니다.",
  "",
  "- 첫째",
  "- 둘째",
].join("\n");
const plainDocument = [
  "정리 메모",
  "",
  "미리보기가 없는 파일과 글 문서의 폭을 비교하는 표본입니다.",
  "이 줄은 창 폭 안에서 접혀야 합니다.",
].join("\n");

function attachmentItem(kind: string): ChatAttachmentItem {
  const context = {type: "card" as const, id: "card-1"};
  const originalUrl = `/api/attachments/fixture-image/content?context_type=card&context_id=card-1&download=true`;
  if (kind === "image-small" || kind === "image-large") return {
    key: `asset:${kind}`, name: "fixture.svg", mimeType: "image/svg+xml", byteSize: 1024,
    previewKind: "image", availability: "ready", previewUrl: src, originalUrl, legacySources: [],
    source: {kind: "asset", attachmentId: "fixture-image", context},
  };
  if (kind === "slow-doc") return {
    key: "asset:slow-doc", name: "느린 문서.md", mimeType: "text/markdown", byteSize: 4096,
    previewKind: "text", availability: "ready",
    previewUrl: `/api/attachments/slow-doc/content?context_type=card&context_id=card-1`,
    originalUrl: `/api/attachments/slow-doc/content?context_type=card&context_id=card-1&download=true`,
    legacySources: [], source: {kind: "asset", attachmentId: "slow-doc", context},
  };
  if (kind === "html-slow") return {
    key: "asset:html-slow", name: "느린 화면.html", mimeType: "text/html", byteSize: 4096,
    previewKind: "text", availability: "ready",
    previewUrl: `/api/attachments/slow-html/content?context_type=card&context_id=card-1`,
    originalUrl: `/api/attachments/slow-html/content?context_type=card&context_id=card-1&download=true`,
    legacySources: [], source: {kind: "asset", attachmentId: "slow-html", context},
  };
  if (kind === "video-narrow") return {
    key: "local:video-narrow", name: "sample-video.mp4", mimeType: "video/mp4", byteSize: narrowVideo.size,
    previewKind: "info", availability: "ready", previewUrl: null, originalUrl: null,
    legacySources: [], source: {kind: "local", file: narrowVideo},
  };
  if (kind === "missing") return {
    key: "asset:missing", name: "사라진 문서.md", mimeType: "text/markdown", byteSize: 120,
    previewKind: "text", availability: "missing", previewUrl: null, originalUrl: null,
    legacySources: [], source: {kind: "unavailable", attachmentId: "missing", context},
  };
  const text = kind === "doc-short" ? shortDocument : kind === "text" ? plainDocument : longDocument;
  const file = new File([text], kind === "text" ? "정리 메모.txt" : kind === "doc-short" ? "짧은 문서.md" : "미리 해 둘 정리 작업 모음.md",
    {type: kind === "text" ? "text/plain" : "text/markdown"});
  return {
    key: `local:${kind}`, name: file.name, mimeType: file.type, byteSize: file.size,
    previewKind: "text", availability: "ready", previewUrl: null, originalUrl: null,
    legacySources: [], source: {kind: "local", file},
  };
}

function attachmentItems(kind: string): ChatAttachmentItem[] {
  if (kind === "gallery-docs") return [attachmentItem("doc-short"), attachmentItem("text")];
  if (kind === "gallery-mixed") return [attachmentItem("image-small"), attachmentItem("doc-short"), attachmentItem("video-narrow")];
  return [attachmentItem(kind)];
}

function AttachmentFixture({kind}:{kind:string}) {
  const [index, setIndex] = useState<number|null>(0);
  const items = attachmentItems(kind);
  return <AttachmentViewer items={items} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)}/>;
}

function Fixture() {
  const [open, setOpen] = useState(true);
  const viewer = params.get("viewer");
  return <main>
    {viewer === "card" && <CardImageViewer image={open ? {src, alt:caption} : null} onClose={() => setOpen(false)}/>}
    {viewer === "file" && <FileAttachmentPreview initialImageOpen file={file} status="done" onRemove={() => {}}/>}
    {viewer === "chat" && <MarkdownContent content={`![fixture.svg](/fixture.svg?width=${width}&height=${height})${params.get("gallery") === "single" ? "" : "\n\n![next.svg](/next.svg)"}${params.get("gallery") === "mixed" ? "\n\n![third.svg](/third.svg?width=800&height=600)\n\n![last.svg](/last.svg?width=200&height=120)" : ""}`} chatImages={{role:"assistant"}} />}
    {viewer === "ordinary" && <Dialog open={open} onOpenChange={setOpen}><DialogPopup><DialogHeader><DialogTitle>기존 다이얼로그</DialogTitle></DialogHeader></DialogPopup></Dialog>}
    {viewer === "attachment" && <AttachmentFixture kind={params.get("attachment") ?? "doc-long"}/>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
