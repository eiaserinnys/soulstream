// 카드 #429 시안 (보완판): 웹 첨부 보기 창(AttachmentViewer)의 그림, SVG, HEIC, HTML.
//
// 그림 장면은 운영 AttachmentViewer의 그림 갈래와 같은 Dialog 부품, 클래스, 상태 문구로 그리고
// 바뀌는 것만 더한다. 구현에서는 이 갈래를 AttachmentViewer 안에 넣는다.
//
// - 틀은 그림을 받은 뒤 정한다. 첨부 정보에 가로세로가 없고, HEIC는 크롬 같은 브라우저에서
//   웹이 해독기를 그때 불러 그리기 때문이다. 받는 동안과 실패는 지금 이미지 창 그대로다.
// - 읽기 크기: 지금 창처럼 통째로 맞추면 짧은 변이 기준 길이의 절반보다 작아지는 그림만
//   읽기 크기로 열고 닫기 옆에 전환 단추를 둔다. 기준 길이는 휴대폰 폭 틀(--container-md)의
//   그림 폭(398px)이고, 화면이 더 좁으면 그 화면의 그림 폭, 원래 더 작은 그림은 원래 길이다.
//   그래서 데스크톱에서는 짧은 변이 약 200px보다 작아질 때 나온다. 폭 상한과 무관하다.
//   읽기 크기는 세로로 긴 그림이면 폭 맞춤(세로 스크롤), 가로로 긴 그림이면 높이 맞춤
//   (가로 스크롤)이다. 배율은 1배를 넘지 않는다.
//   세로로 긴 그림의 틀은 폭 상한(기본 --container-3xl 768px, 비교안 --container-md 448px),
//   가로로 긴 그림의 틀은 화면 폭이다. 두 모드가 같은 틀을 쓰고 그림 배율만 바뀐다.
// - 전체 보기에서 돌아오면 떠난 스크롤 비율을 되살린다. 창 크기가 바뀌어도 비율을 지킨다.
// - 읽기 크기에서는 스크롤 영역이 Tab 자리이고 창을 열면 처음 초점이 그곳이다.
//   구현에서는 soul-ui ScrollArea에 뷰포트 속성(tabIndex, 이름)을 넘기는 길을 더한다.
//   여러 첨부를 넘기는 창에서 가로 스크롤 영역에 초점이 있으면 ←, →는 스크롤이 쓴다.
// - SVG는 img로만 그려 안의 스크립트가 돌지 않고, HTML 틀과 같은 밝은 바탕을 깐다.
// - HEIC: 서버는 변환하지 않는다. 사파리와 iOS는 원래대로 그리고, 그 밖의 브라우저는
//   웹이 해독기를 그때 불러 그린다. 시안은 해독 결과 그림을 늦게 내어 그 흐름을 보인다.
// - HTML: 저장은 다른 형식처럼 바닥줄 「원본 저장」이다. srcdoc 끝에 Esc를 부모 창으로
//   알리는 짧은 스크립트를 넣어, 안을 누른 뒤에도 Esc로 창이 닫힌다.
import { mockupParams } from "../_shell/mock-env";
import { mountMockup } from "../_shell/MockupShell";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from "react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { Download, MoveHorizontal, MoveVertical, Shrink, XIcon } from "lucide-react";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { CustomViewIframe } from "@seosoyoung/soul-ui/custom-view/CustomViewRenderer";
import { Button } from "@seosoyoung/soul-ui/components/ui/button";
import {
  Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle,
} from "@seosoyoung/soul-ui/components/ui/dialog";
import { ScrollBar } from "@seosoyoung/soul-ui/components/ui/scroll-area";
import { formatFileSize } from "@seosoyoung/soul-ui/lib/format-file-size";
import tallUrl from "./tall-chat.png";
import wideUrl from "./wide-timeline.png";
import svgUrl from "./diagram.svg";
import clearSvgUrl from "./diagram-clear.svg";
import heicDecodedUrl from "./heic-decoded.jpg";
import sampleHtml from "./sample-cards.html?raw";
import "./attachment-viewer-429.css";

type Scene = "tall" | "tall-whole" | "compare" | "wide" | "loading" | "failed" | "svg" | "svg-clear" | "heic" | "html";
const SCENES: { id: Scene; label: string }[] = [
  { id: "tall", label: "긴 캡처" },
  { id: "tall-whole", label: "긴 캡처 · 전체" },
  { id: "compare", label: "폭 상한 비교" },
  { id: "wide", label: "넓은 그림" },
  { id: "loading", label: "받는 중" },
  { id: "failed", label: "실패" },
  { id: "svg", label: "SVG" },
  { id: "svg-clear", label: "SVG · 투명" },
  { id: "heic", label: "HEIC" },
  { id: "html", label: "HTML" },
];
const LEGACY_SCENES: Record<string, Scene> = { "tall-width": "tall", "tall-fit": "tall-whole" };

type Cap = "3xl" | "md";
const CAPS: { id: Cap; label: string }[] = [
  { id: "3xl", label: "폭 상한 768" },
  { id: "md", label: "폭 상한 448" },
];

// 받는 중 장면을 캡처할 때 그림을 계속 늦춘다: ?hold=1
const HOLD = mockupParams.get("hold") === "1";

function sceneFromUrl(): Scene {
  const requested = mockupParams.get("scene") ?? "";
  return SCENES.find(scene => scene.id === requested)?.id ?? LEGACY_SCENES[requested] ?? "tall";
}

function capFromUrl(): Cap {
  return mockupParams.get("cap") === "448" ? "md" : "3xl";
}

function setUrlParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, "", url);
}

type ImageAttachment = {
  name: string;
  mimeType: string;
  byteSize: number;
  src: string;
  /** 시안 전용: 그림이 늦게 오는 것을 흉내 낸다(내려받기, HEIC 해독). */
  delayMs?: number;
  /** 시안 전용: 첫 시도는 서버 오류로 실패한다. 「다시 시도」로 받는다. */
  failFirst?: boolean;
};

const TALL: ImageAttachment = { name: "IMG_0398.PNG", mimeType: "image/png", byteSize: 369_747, src: tallUrl };
const WIDE: ImageAttachment = { name: "timeline-2611.png", mimeType: "image/png", byteSize: 89_177, src: wideUrl };
const SVG: ImageAttachment = { name: "attachment-flow.svg", mimeType: "image/svg+xml", byteSize: 2_961, src: svgUrl };
const SVG_CLEAR: ImageAttachment = { name: "flow-lines.svg", mimeType: "image/svg+xml", byteSize: 1_022, src: clearSvgUrl };
// 원본은 HEIC 그대로다. 크롬은 해독기를 불러 그리므로 시안은 해독 결과를 조금 늦게 낸다.
const HEIC: ImageAttachment = {
  name: "IMG_0412.HEIC", mimeType: "image/heic", byteSize: 2_874_112, src: heicDecodedUrl, delayMs: 1200,
};

/** 원본 창과 같은 겉틀. 머리줄 오른쪽에 단추 묶음(전환, 닫기)을 둔다. */
function ViewerFrame({ popupRef, name, size, kind, attributes, style, footer, actions, initialFocus, nonModal, children, onClose }: {
  popupRef: RefObject<HTMLDivElement | null>;
  name: string;
  size: string;
  kind: "image" | "html";
  attributes?: Record<string, string>;
  style?: CSSProperties;
  footer?: ReactNode;
  actions?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  nonModal?: boolean;
  children: ReactNode;
  onClose(): void;
}) {
  return <Dialog
    open
    {...(nonModal ? { modal: false, disablePointerDismissal: true } : {})}
    onOpenChange={open => { if (!open) onClose(); }}
  >
    <DialogPopup
      ref={popupRef}
      initialFocus={initialFocus ?? popupRef}
      showCloseButton={false}
      className="v3-surface image-viewer-popup chat-image-viewer-popup"
      data-attachment-kind={kind}
      style={style}
      {...attributes}
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

/** 머리줄 아이콘 단추. 닫기 단추와 같은 Button(icon, ghost)이고 이름은 aria-label과 title이다. */
function HeaderAction({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return <Button size="icon" variant="ghost" aria-label={label} title={label} onClick={onClick}>{children}</Button>;
}

type Natural = { width: number; height: number };
type Reading = { axis: "y" | "x"; frame: "column" | "full" };
type Fit = "read" | "whole";

/**
 * 읽기 크기를 쓸지 정한다. area는 지금 창의 그림 한계(화면 폭 틀의 그림 자리)이고,
 * referenceWidth는 휴대폰 폭 틀(--container-md, 화면이 더 좁으면 화면)의 그림 폭이다.
 * 지금 창처럼 통째로 맞춘 그림의 짧은 변이 min(원래 길이, 기준 길이)의 절반보다 작을 때만 읽기 크기를 쓴다.
 * 기준 길이는 폭 상한(768, 448)과 무관해서, 어느 상한이든 같은 그림에 전환 단추가 나온다.
 */
function readingFor(natural: Natural, area: { width: number; height: number }, referenceWidth: number): Reading | null {
  const { width, height } = natural;
  if (width <= 0 || height <= 0 || area.width <= 0 || area.height <= 0 || referenceWidth <= 0) return null;
  const reference = Math.min(referenceWidth, area.height);
  const tall = height > width;
  const read = Math.min(1, reference / (tall ? width : height));
  const whole = Math.min(1, area.width / width, area.height / height);
  if (whole >= read / 2) return null;
  return tall ? { axis: "y", frame: "column" } : { axis: "x", frame: "full" };
}

function sizeKey(viewport: HTMLElement): string {
  return `${viewport.clientWidth}x${viewport.clientHeight}:${viewport.scrollWidth}x${viewport.scrollHeight}`;
}

const VIEWPORT_CLASS = "h-full overscroll-contain rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain";

function ImageViewer({ item, cap, initialFit = "read", compare, zoom, onClose }: {
  item: ImageAttachment;
  cap: Cap;
  initialFit?: Fit;
  compare?: boolean;
  /** 폭 상한 비교 장면에서 좁은 화면이면 두 창을 함께 줄인다. */
  zoom?: number;
  onClose(): void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const areaProbeRef = useRef<HTMLSpanElement>(null);
  const referenceProbeRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"waiting" | "loading" | "ready" | "failed">(
    item.delayMs || item.failFirst ? "waiting" : "loading");
  const [natural, setNatural] = useState<Natural | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [fit, setFit] = useState<Fit>(initialFit);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const scrollRatio = useRef(0);
  // 마지막으로 비율을 맞춘 때의 크기. 크기가 바뀌는 중에 브라우저가 위치를 잘라 내며 보내는 scroll은 비율에 넣지 않는다.
  const scrollSize = useRef("");

  // 시안 전용: 늦게 오는 그림과 첫 시도 실패를 흉내 낸다.
  useEffect(() => {
    if (state !== "waiting" || HOLD) return;
    const timer = window.setTimeout(() => {
      setState(item.failFirst && attempt === 0 ? "failed" : "loading");
    }, item.delayMs ?? 0);
    return () => window.clearTimeout(timer);
  }, [state, attempt, item.delayMs, item.failFirst]);

  const measure = useCallback(() => {
    const area = areaProbeRef.current?.getBoundingClientRect();
    const reference = referenceProbeRef.current?.getBoundingClientRect();
    if (!natural || !area || !reference) return;
    const next = readingFor(natural, area, reference.width);
    setReading(previous => previous?.axis === next?.axis && previous?.frame === next?.frame ? previous : next);
  }, [natural]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const axis = reading?.axis ?? "y";
  const scrollMax = (viewport: HTMLElement) => axis === "y"
    ? viewport.scrollHeight - viewport.clientHeight
    : viewport.scrollWidth - viewport.clientWidth;
  const applyRatio = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || fitRef.current !== "read") return;
    scrollSize.current = sizeKey(viewport);
    const max = axis === "y" ? viewport.scrollHeight - viewport.clientHeight : viewport.scrollWidth - viewport.clientWidth;
    const position = Math.round(scrollRatio.current * Math.max(0, max));
    if (axis === "y") viewport.scrollTop = position;
    else viewport.scrollLeft = position;
  }, [axis]);

  // 전체 보기에서 돌아오면 떠난 비율로, 창 크기가 바뀌어도 같은 비율로 둔다.
  useLayoutEffect(() => {
    if (fit === "read") applyRatio();
  }, [fit, reading, applyRatio]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => applyRatio());
    observer.observe(viewport);
    const image = viewport.querySelector("img");
    if (image) observer.observe(image);
    return () => observer.disconnect();
  }, [reading, applyRatio]);

  // 읽기 크기로 정해지면, 아직 아무 데도 옮기지 않은 처음 초점을 스크롤 영역에 둔다.
  // 그림이 캐시에서 바로 오면 창이 처음 초점을 잡기 전에 정해질 수 있어 다음 틀에서 한 번 더 본다.
  // 비교 장면은 두 창이 나란히 열리므로 옮기지 않는다.
  useEffect(() => {
    if (!reading || fit !== "read" || compare) return;
    const moveInitialFocus = () => {
      const popup = popupRef.current;
      const active = document.activeElement;
      if (popup && (active === popup || active === document.body || active === null)) {
        viewportRef.current?.focus({ preventScroll: true });
      }
    };
    moveInitialFocus();
    const frame = window.requestAnimationFrame(moveInitialFocus);
    const timer = window.setTimeout(moveInitialFocus, 250);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
    // 처음 정해질 때만 옮긴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading]);

  const toggleFit = () => setFit(current => current === "read" ? "whole" : "read");
  const onScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport || fitRef.current !== "read" || sizeKey(viewport) !== scrollSize.current) return;
    const max = scrollMax(viewport);
    scrollRatio.current = max > 0 ? (axis === "y" ? viewport.scrollTop : viewport.scrollLeft) / max : 0;
  };

  const image = <MarkdownImage
    key={`${item.src}:${attempt}`}
    src={item.src}
    alt={item.name}
    variant="chatRefined"
    loading="eager"
    className="chat-image-viewer-image"
    onLoad={() => {
      const element = popupRef.current?.querySelector<HTMLImageElement>("img.chat-image-viewer-image");
      if (element && element.naturalWidth > 0) {
        setNatural(previous => previous?.width === element.naturalWidth && previous.height === element.naturalHeight
          ? previous : { width: element.naturalWidth, height: element.naturalHeight });
      }
      setState("ready");
    }}
    onError={() => setState("failed")}
  />;

  const readingActive = state === "ready" && reading !== null;
  const body = state === "waiting"
    ? <div className="chat-attachment-state chat-image-status" role="status">이미지 불러오는 중…</div>
    : state === "failed"
      ? <div className="chat-attachment-state chat-image-status" role="status">
        <span data-slot="dialog-error-message">이미지를 불러오지 못했습니다.</span>
        <Button variant="outline" size="sm" onClick={() => {
          setAttempt(value => value + 1);
          setState("loading");
        }}>다시 시도</Button>
      </div>
      : readingActive
        ? <ScrollAreaPrimitive.Root
          className="size-full min-h-0 attachment-viewer-429-scroll"
          data-fit={fit}
          data-axis={reading.axis}
        >
          <ScrollAreaPrimitive.Viewport
            ref={viewportRef}
            className={VIEWPORT_CLASS}
            data-slot="scroll-area-viewport"
            role="region"
            aria-label={item.name}
            tabIndex={fit === "read" ? 0 : -1}
            onScroll={onScroll}
          >
            {image}
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </ScrollAreaPrimitive.Root>
        : image;

  const format = item.mimeType === "image/svg+xml" ? "svg" : "raster";
  const attributes: Record<string, string> = {
    "data-image-state": state,
    "data-image-format": format,
    "data-cap": cap,
    ...(readingActive ? { "data-image-frame": reading.frame, "data-image-fit": fit } : {}),
    ...(compare ? { "data-compare": cap } : {}),
  };
  const style = {
    ...(natural ? {
      "--attachment-natural-width": `${natural.width}px`,
      "--attachment-natural-height": `${natural.height}px`,
    } : {}),
    ...(zoom !== undefined && zoom < 1 ? { zoom } : {}),
  } as CSSProperties;
  const readLabel = reading?.axis === "x" ? "높이에 맞춤" : "폭에 맞춤";
  const actions = readingActive
    ? fit === "read"
      ? <HeaderAction label="전체 보기" onClick={toggleFit}><Shrink /></HeaderAction>
      : <HeaderAction label={readLabel} onClick={toggleFit}>
        {reading.axis === "x" ? <MoveVertical /> : <MoveHorizontal />}
      </HeaderAction>
    : null;

  return <ViewerFrame
    popupRef={popupRef}
    name={item.name}
    size={formatFileSize(item.byteSize)}
    kind="image"
    attributes={attributes}
    style={style}
    actions={actions}
    nonModal={compare}
    footer={<SaveFooter />}
    onClose={onClose}
  >
    {body}
    <span ref={areaProbeRef} className="attachment-viewer-429-probe" aria-hidden="true" />
    <span ref={referenceProbeRef} className="attachment-viewer-429-probe attachment-viewer-429-probe-reference" aria-hidden="true" />
  </ViewerFrame>;
}

const ESCAPE_MESSAGE = "attachment-viewer:escape";
// 보기 창이 srcdoc 끝에 넣는 짧은 스크립트. 안에서 누른 Esc를 부모 창에 알린다.
const ESCAPE_RELAY = `<script>addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented)parent.postMessage({type:"${ESCAPE_MESSAGE}"},"*")})</script>`;

function withEscapeRelay(html: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${ESCAPE_RELAY}</body>`) : `${html}${ESCAPE_RELAY}`;
}

/** HTML 첨부. sandbox="allow-scripts" srcdoc 프레임이 화면을 채우고, 저장은 다른 형식처럼 바닥줄이다. */
function HtmlViewer({ onClose }: { onClose(): void }) {
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = popupRef.current?.querySelector("iframe");
      if (frame && event.source === frame.contentWindow
        && (event.data as { type?: unknown } | null)?.type === ESCAPE_MESSAGE) onClose();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onClose]);
  return <ViewerFrame
    popupRef={popupRef}
    name="weekly-cards.html" size={formatFileSize(sampleHtml.length)} kind="html"
    footer={<SaveFooter />}
    onClose={onClose}
  >
    <CustomViewIframe html={withEscapeRelay(sampleHtml)} title="weekly-cards.html" className="chat-attachment-html-frame" />
  </ViewerFrame>;
}

/** 폭 상한 비교: 같은 긴 캡처를 768과 448 틀에 나란히 연다. 좁은 화면에서는 둘을 함께 줄여 보인다. */
function CompareScene({ onClose }: { onClose(): void }) {
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const update = () => {
      const root = getComputedStyle(document.documentElement);
      const rem = Number.parseFloat(root.fontSize) || 16;
      // 두 틀 폭과 사이 간격, 바깥 여백(p-4 두 번).
      const need = (48 + 28 + 1.5 + 2) * rem;
      setZoom(Math.min(1, window.innerWidth / need));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return <>
    <ImageViewer item={TALL} cap="3xl" compare zoom={zoom} onClose={onClose} />
    <ImageViewer item={TALL} cap="md" compare zoom={zoom} onClose={onClose} />
  </>;
}

/** 발행 페이지의 코멘트 단추가 좁은 화면에서 바닥줄 「원본 저장」을 덮지 않게 왼쪽으로 비킨다(시안 페이지만). */
function moveReviewButtonAside() {
  const apply = () => {
    const root = document.getElementById("pages-review")?.shadowRoot;
    if (!root) return false;
    if (!root.querySelector("style[data-mockup-aside]")) {
      const style = document.createElement("style");
      style.setAttribute("data-mockup-aside", "");
      style.textContent = "@media (max-width: 40rem) { #toggle { right: auto; left: 16px; } }";
      root.append(style);
    }
    return true;
  };
  if (apply()) return;
  const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
  observer.observe(document.body, { childList: true });
}

function MockupPage() {
  const [scene, setScene] = useState<Scene | null>(sceneFromUrl);
  const [cap, setCap] = useState<Cap>(capFromUrl);
  useEffect(moveReviewButtonAside, []);
  const open = (next: Scene) => {
    setUrlParam("scene", next);
    setScene(next);
  };
  const close = useCallback(() => setScene(null), []);
  const chooseCap = (next: Cap) => {
    setUrlParam("cap", next === "md" ? "448" : null);
    setCap(next);
  };
  return <>
    <div className="attachment-viewer-429-page">
      <nav className="attachment-viewer-429-scenes" aria-label="시안 장면">
        {SCENES.map(item => <Button key={item.id} variant="outline" size="sm" onClick={() => open(item.id)}>{item.label}</Button>)}
      </nav>
      <div className="attachment-viewer-429-scenes" role="group" aria-label="긴 캡처 폭 상한">
        {CAPS.map(item => <Button key={item.id} size="sm" variant={item.id === cap ? "default" : "outline"}
          aria-pressed={item.id === cap} onClick={() => chooseCap(item.id)}>{item.label}</Button>)}
      </div>
      <details className="attachment-viewer-429-notes">
        <summary>시안 메모</summary>
        <ul>
          <li>전환 단추는 통째로 맞추면 짧은 변이 약 200px(휴대폰은 화면 폭의 절반)보다 작아지는 그림에만 나오고, 그때는 읽기 크기로 엽니다. 세로로 길면 폭 맞춤, 가로로 길면 높이 맞춤입니다. 보통 사진과 휴대폰 캡처 한 장은 지금처럼 통째로 보입니다.</li>
          <li>틀은 그림을 받은 뒤 정합니다. 받는 동안과 실패는 지금 이미지 창 그대로입니다.</li>
          <li>폭 상한 448은 1170px 휴대폰 캡처를 휴대폰에서 보던 글자 크기(약 1.02배)로 보입니다. 768은 약 1.8배입니다.</li>
          <li>HEIC는 서버가 바꾸지 않습니다. 사파리와 iOS는 그대로, 그 밖의 브라우저는 해독기를 그때 불러 그립니다.</li>
          <li>SVG는 img로만 그리고 HTML 틀과 같은 밝은 바탕을 깝니다.</li>
        </ul>
      </details>
    </div>
    {scene === "tall" && <ImageViewer key={`tall-${cap}`} item={TALL} cap={cap} onClose={close} />}
    {scene === "tall-whole" && <ImageViewer key={`whole-${cap}`} item={TALL} cap={cap} initialFit="whole" onClose={close} />}
    {scene === "compare" && <CompareScene onClose={close} />}
    {scene === "wide" && <ImageViewer item={WIDE} cap={cap} onClose={close} />}
    {scene === "loading" && <ImageViewer key={`loading-${cap}`} item={{ ...TALL, delayMs: 2500 }} cap={cap} onClose={close} />}
    {scene === "failed" && <ImageViewer key={`failed-${cap}`} item={{ ...TALL, failFirst: true }} cap={cap} onClose={close} />}
    {scene === "svg" && <ImageViewer item={SVG} cap={cap} onClose={close} />}
    {scene === "svg-clear" && <ImageViewer item={SVG_CLEAR} cap={cap} onClose={close} />}
    {scene === "heic" && <ImageViewer item={HEIC} cap={cap} onClose={close} />}
    {scene === "html" && <HtmlViewer onClose={close} />}
  </>;
}

mountMockup(<MockupPage />);
