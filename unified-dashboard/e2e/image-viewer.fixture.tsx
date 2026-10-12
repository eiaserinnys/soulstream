import "../client/globals.css";
import "../client/v3/v3-visual-system.css";
import "../client/v3/v3-card-check-items.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardImageViewer } from "../client/v3/CardImageViewer";
import { FileAttachmentPreview } from "@seosoyoung/soul-ui/components/FileAttachmentPreview";
import { MarkdownContent } from "@seosoyoung/soul-ui/components/MarkdownContent";
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
const caption = params.get("caption") === "none" ? "" : params.get("caption") === "long"
  ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(5)
  : params.get("caption") === "one" ? "화면 캡처"
  : params.get("caption") === "small-long" ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(3)
  : params.get("caption") === "forty-three" ? "원본 화면의 글자와 배치를 확인하는 이미지입니다. 화면 상태와 설명을 봅니다."
  : params.get("caption") === "two" ? "192 이미지의 상태와 배치를 확인합니다."
  : params.get("caption") === "three"
  ? "원본 화면에서 글자를 읽고 상태와 배치를 확인할 수 있는 증거 이미지입니다. ".repeat(2)
  : "첫 번째 설명 줄\n두 번째 설명 줄\n세 번째 설명 줄";

function Fixture() {
  const [open, setOpen] = useState(true);
  const viewer = params.get("viewer");
  return <main>
    {viewer === "card" && <CardImageViewer image={open ? {src, alt:caption} : null} onClose={() => setOpen(false)}/>}
    {viewer === "file" && <FileAttachmentPreview initialImageOpen file={file} status="done" onRemove={() => {}}/>}
    {viewer === "chat" && <MarkdownContent content={`![fixture.svg](/fixture.svg?width=${width}&height=${height})${params.get("gallery") === "single" ? "" : "\n\n![next.svg](/next.svg)"}${params.get("gallery") === "mixed" ? "\n\n![third.svg](/third.svg?width=800&height=600)\n\n![last.svg](/last.svg?width=200&height=120)" : ""}`} chatImages={{role:"assistant"}} />}
    {viewer === "ordinary" && <Dialog open={open} onOpenChange={setOpen}><DialogPopup><DialogHeader><DialogTitle>기존 다이얼로그</DialogTitle></DialogHeader></DialogPopup></Dialog>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
