// 카드 #429 시안: 웹 이미지 원본 창(AttachmentViewer)의 첨부 보기 정비.
// svg, heic 장면은 운영 AttachmentViewer를 그대로 쓴다(바뀌는 것은 서버의 형식 판정과 미리보기 생성뿐이다).
// 긴 캡처와 HTML 장면은 원본 창과 같은 Dialog 부품과 클래스로 감싸고, 바뀐 머리줄 단추와 스크롤만 더한다.
import { mockupParams } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Download, MoveHorizontal, Shrink, XIcon } from "lucide-react";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import { Button } from "@seosoyoung/soul-ui/components/ui/button";
import {
  Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "@seosoyoung/soul-ui/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "@seosoyoung/soul-ui/components/ui/popover";
import { ScrollArea } from "@seosoyoung/soul-ui/components/ui/scroll-area";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import tallUrl from "./tall-chat.png";
import svgUrl from "./diagram.svg";
import heicPreviewUrl from "./heic-preview.jpg";
import sampleHtml from "./sample-cards.html?raw";
import "./attachment-viewer-429.css";

type Scene = "tall-width" | "tall-fit" | "svg" | "heic" | "html";
const SCENES: { id: Scene; label: string }[] = [
  { id: "tall-width", label: "긴 캡처 · 폭 맞춤" },
  { id: "tall-fit", label: "긴 캡처 · 전체" },
  { id: "svg", label: "SVG" },
  { id: "heic", label: "HEIC" },
  { id: "html", label: "HTML" },
];

function sceneFromUrl(): Scene {
  const requested = mockupParams.get("scene");
  return SCENES.find(scene => scene.id === requested)?.id ?? "tall-width";
}

function imageItem(key: string, name: string, mimeType: string, byteSize: number, url: string): ChatAttachmentItem {
  return {
    key, name, mimeType, byteSize,
    previewKind: "image",
    availability: "ready",
    previewUrl: url,
    originalUrl: url,
    legacySources: [],
    source: { kind: "markdown-image", src: url, alt: name },
  };
}

const SVG_ITEM = imageItem("svg", "attachment-flow.svg", "image/svg+xml", 2978, svgUrl);
// 원본은 HEIC 그대로 두고, 서버가 만든 JPEG 미리보기를 previewUrl로 준다.
const HEIC_ITEM = imageItem("heic", "IMG_0412.HEIC", "image/heic", 2_874_112, heicPreviewUrl);

/** 머리줄 아이콘 단추. 닫기 단추와 같은 Button(icon, ghost)이고, 이름은 툴팁으로 보인다. */
function HeaderAction({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <Popover>
    <PopoverTrigger openOnHover delay={300}
      render={<Button size="icon" variant="ghost" aria-label={label} onClick={onClick} />}>
      {children}
    </PopoverTrigger>
    <PopoverPopup tooltipStyle side="bottom">{label}</PopoverPopup>
  </Popover>;
}

/** 원본 창과 같은 겉틀. 닫기 단추를 머리줄 단추 묶음의 끝에 둔다. */
function ViewerFrame({ name, size, kind, fit, naturalWidth, actions, footer, children, onClose }: {
  name: string;
  size: string;
  kind: "image" | "html";
  fit?: "width" | "whole";
  naturalWidth?: number;
  actions: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onClose(): void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup
      ref={popupRef}
      initialFocus={popupRef}
      showCloseButton={false}
      className="v3-surface image-viewer-popup chat-image-viewer-popup"
      data-attachment-kind={kind}
      {...(fit ? { "data-image-fit": fit } : {})}
      style={naturalWidth ? { "--attachment-natural-width": `${naturalWidth}px` } as CSSProperties : undefined}
    >
      <DialogHeader className="chat-image-viewer-header">
        <DialogTitle data-slot="attachment-name" className="chat-image-viewer-title">{name}</DialogTitle>
        <p className="chat-image-viewer-metadata">{size}</p>
      </DialogHeader>
      <DialogPanel scrollFade={false} scrollable={false} className="chat-image-viewer-panel">
        {children}
      </DialogPanel>
      {footer}
      <div className="attachment-viewer-429-actions">
        {actions}
        <DialogClose aria-label="닫기" render={<Button size="icon" variant="ghost" />}><XIcon /></DialogClose>
      </div>
    </DialogPopup>
  </Dialog>;
}

function SaveFooter() {
  return <DialogFooter className="chat-image-viewer-footer">
    <Button variant="outline" size="sm" className="chat-image-viewer-save max-sm:size-9 max-sm:px-0" aria-label="원본 저장">
      <Download aria-hidden="true" />
      <span className="max-sm:sr-only">원본 저장</span>
    </Button>
  </DialogFooter>;
}

/** 긴 캡처. 기본은 폭 맞춤(추천안), 머리줄 단추로 전체 보기와 오간다. */
function TallCaptureViewer({ initialFit, onClose }: { initialFit: "width" | "whole"; onClose(): void }) {
  const [fit, setFit] = useState(initialFit);
  const image = <MarkdownImage src={tallUrl} alt="채팅 캡처" variant="chatRefined" loading="eager" className="chat-image-viewer-image" />;
  return <ViewerFrame
    name="IMG_0398.PNG" size="386.9 KB" kind="image" fit={fit} naturalWidth={1170}
    onClose={onClose}
    actions={fit === "width"
      ? <HeaderAction label="전체 보기" onClick={() => setFit("whole")}><Shrink /></HeaderAction>
      : <HeaderAction label="폭에 맞춤" onClick={() => setFit("width")}><MoveHorizontal /></HeaderAction>}
    footer={<SaveFooter />}
  >
    {fit === "width"
      ? <ScrollArea className="attachment-viewer-429-scroll">{image}</ScrollArea>
      : image}
  </ViewerFrame>;
}

/** HTML 첨부. sandbox="allow-scripts" srcdoc 프레임이 화면을 거의 채우고, 저장은 머리줄로 올린다. */
function HtmlViewer({ onClose }: { onClose(): void }) {
  return <ViewerFrame
    name="weekly-cards.html" size="2.1 KB" kind="html" onClose={onClose}
    actions={<HeaderAction label="원본 저장" onClick={() => {}}><Download /></HeaderAction>}
  >
    <CustomViewIframe html={sampleHtml} title="weekly-cards.html" className="chat-attachment-html-frame" />
  </ViewerFrame>;
}

function MockupPage() {
  const [scene, setScene] = useState<Scene | null>(sceneFromUrl);
  const open = (next: Scene) => {
    const url = new URL(window.location.href);
    url.searchParams.set("scene", next);
    window.history.replaceState(null, "", url);
    setScene(next);
  };
  const close = () => setScene(null);
  return <>
    <nav className="attachment-viewer-429-scenes" aria-label="시안 장면">
      {SCENES.map(item => <Button key={item.id} variant="outline" size="sm" onClick={() => open(item.id)}>{item.label}</Button>)}
    </nav>
    {scene === "tall-width" && <TallCaptureViewer key="width" initialFit="width" onClose={close} />}
    {scene === "tall-fit" && <TallCaptureViewer key="whole" initialFit="whole" onClose={close} />}
    {scene === "svg" && <AttachmentViewer items={[SVG_ITEM]} index={0} onIndexChange={() => {}} onClose={close} />}
    {scene === "heic" && <AttachmentViewer items={[HEIC_ITEM]} index={0} onIndexChange={() => {}} onClose={close} />}
    {scene === "html" && <HtmlViewer onClose={close} />}
  </>;
}

mountMockup(<MockupPage />);
