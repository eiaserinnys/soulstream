"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { FileTypeIcon } from "./FileAttachmentPreview";
import { formatFileSize } from "../lib/format-file-size";
import { MarkdownImage } from "./MarkdownImage";
import { AttachmentDownloadError, downloadAttachmentOriginal, downloadLocalAttachmentOriginal } from "../lib/attachment-download";
import { AttachmentTextPreviewError, readAttachmentText, readLocalAttachmentText, type AttachmentTextPreview } from "../lib/attachment-text-preview";
import {
  attachmentMediaFormat,
  attachmentMediaSourceUrl,
  attachmentTextFormat,
  type ChatAttachmentItem,
} from "../lib/chat-attachment-model";
import { DocumentMarkdown } from "./DocumentMarkdown";
import { CustomViewIframe } from "../custom-view/CustomViewRenderer";
import {
  AttachmentViewerFitToggle,
  AttachmentViewerImageStatus,
  AttachmentViewerProbes,
  useAttachmentViewerImage,
} from "./AttachmentViewerImage";

const ESCAPE_MESSAGE = "attachment-viewer:escape";
// The viewer puts this short script at the end of the HTML document. Esc pressed
// inside the sandboxed frame (no same-origin access) is relayed to the parent.
const ESCAPE_RELAY = `<script>addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented)parent.postMessage({type:"${ESCAPE_MESSAGE}"},"*")})</script>`;

function withEscapeRelay(html: string): string {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${ESCAPE_RELAY}</body>`) : `${html}${ESCAPE_RELAY}`;
}

type TextState =
  | { key: string; state: "loading" }
  | { key: string; state: "ready"; result: AttachmentTextPreview }
  | { key: string; state: "error"; message: string; retryable: boolean };

function canRetryError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof AttachmentTextPreviewError
    && error.status !== null && error.status >= 500);
}

function textErrorMessage(error: unknown): string {
  if (error instanceof AttachmentTextPreviewError) {
    if (error.code === "TEXT_PREVIEW_UNSUPPORTED_ENCODING") return "이 문자 인코딩은 미리볼 수 없습니다.";
    if (error.status === 401 || error.status === 403) return "첨부를 읽을 수 없습니다.";
    if (error.status === 404) return "첨부를 찾을 수 없습니다.";
    if (error.status !== null && error.status >= 500) return "첨부를 불러오지 못했습니다.";
  }
  return "미리보기를 불러오지 못했습니다.";
}

function mediaError(status: number): { message: string; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { message: "첨부를 읽을 수 없습니다.", retryable: false };
  }
  if (status === 404) return { message: "첨부를 찾을 수 없습니다.", retryable: false };
  if (status >= 500) return { message: "첨부를 불러오지 못했습니다.", retryable: true };
  return { message: "미리보기를 불러오지 못했습니다.", retryable: false };
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof AttachmentDownloadError && (error.status === 401 || error.status === 403)) {
    return "첨부를 저장할 수 없습니다.";
  }
  return "원본 파일을 저장할 수 없습니다.";
}

export function AttachmentViewer({
  items,
  index,
  onIndexChange,
  onClose,
  returnFocus,
  panelContent,
}: {
  items: ChatAttachmentItem[];
  index: number | null;
  onIndexChange(index: number): void;
  onClose(): void;
  returnFocus?: HTMLElement | null;
  panelContent?: ReactNode;
}): ReactNode {
  const item = index === null ? undefined : items[index];
  const localFile = item?.source.kind === "local" ? item.source.file : undefined;
  const mediaFormat = item ? attachmentMediaFormat(item) : null;
  const previewKey = item
    ? JSON.stringify([item.key, item.previewUrl, item.byteSize, item.mimeType, localFile?.name, localFile?.size])
    : "";
  const popupRef = useRef<HTMLDivElement>(null);
  const imageMediaRef = useRef<HTMLDivElement>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [textState, setTextState] = useState<TextState | null>(null);
  const [mediaFailureKey, setMediaFailureKey] = useState<string | null>(null);
  const [mediaFailureMessage, setMediaFailureMessage] = useState<string | null>(null);
  const [mediaRetryKey, setMediaRetryKey] = useState<string | null>(null);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [localPreview, setLocalPreview] = useState<{ key: string; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (!item || item.previewKind !== "text") return;
    const controller = new AbortController();
    setTextState({ key: previewKey, state: "loading" });

    const read = item.availability === "missing" || item.availability === "unavailable"
      ? Promise.reject(new Error("Attachment is unavailable"))
      : localFile
        ? readLocalAttachmentText(localFile, controller.signal)
        : item.previewUrl !== null
          ? readAttachmentText({ url: item.previewUrl, byteSize: item.byteSize, signal: controller.signal })
          : Promise.reject(new Error("Attachment preview metadata is unavailable"));

    void read.then(result => {
      if (!controller.signal.aborted) setTextState({ key: previewKey, state: "ready", result });
    }).catch(error => {
      if (!controller.signal.aborted) {
        const message = item.availability === "missing"
          ? "첨부를 찾을 수 없습니다."
          : item.availability === "unavailable"
            ? "첨부를 사용할 수 없습니다."
            : textErrorMessage(error);
        setTextState({ key: previewKey, state: "error", message, retryable: canRetryError(error) });
      }
    });

    return () => controller.abort();
  }, [item?.key, item?.previewKind, item?.previewUrl, item?.byteSize, item?.availability, localFile, previewKey, retryCount]);

  useEffect(() => {
    if (!item || !localFile || item.previewUrl !== null || (
      item.previewKind !== "image" && mediaFormat === null
    ) || (mediaFormat !== null && localFile.size === 0)) {
      setLocalPreview(null);
      return;
    }
    const url = URL.createObjectURL(localFile);
    setLocalPreview({ key: previewKey, url });
    return () => URL.revokeObjectURL(url);
  }, [item?.key, item?.previewKind, item?.previewUrl, localFile, mediaFormat, previewKey]);

  const imageSource = item?.previewUrl
    ?? (item?.source.kind === "markdown-image" ? item.source.src : undefined)
    ?? (localPreview?.key === previewKey ? localPreview.url : undefined);
  const mediaSource = localFile
    ? (localPreview?.key === previewKey ? localPreview.url : undefined)
    : item ? attachmentMediaSourceUrl(item) ?? undefined : undefined;
  const emptyMedia = mediaFormat !== null && (
    item?.byteSize === 0 || localFile?.size === 0
  );
  const imageViewer = useAttachmentViewerImage({
    popupRef,
    mediaRef: imageMediaRef,
    src: item?.previewKind === "image" ? imageSource : undefined,
    mimeType: item?.mimeType,
    label: item?.name ?? "첨부 이미지",
  });

  // Esc inside the sandboxed HTML preview cannot reach the dialog, so the relay
  // script posts it here. Accept only messages from this viewer's iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = popupRef.current?.querySelector("iframe");
      if (frame && event.source === frame.contentWindow
        && (event.data as { type?: unknown } | null)?.type === ESCAPE_MESSAGE) onClose();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onClose]);

  useEffect(() => {
    if (
      mediaFailureKey !== previewKey || !mediaSource || mediaSource.startsWith("blob:") || emptyMedia
    ) return;
    const controller = new AbortController();
    void fetch(mediaSource, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!controller.signal.aborted) {
          const failure = mediaError(response.status);
          setMediaFailureMessage(failure.message);
          setMediaRetryKey(failure.retryable ? previewKey : null);
        }
        await response.body?.cancel();
      }).catch(error => {
        if (!controller.signal.aborted) {
          const retryable = error instanceof TypeError;
          setMediaFailureMessage(retryable ? "첨부를 불러오지 못했습니다." : "미리보기를 불러오지 못했습니다.");
          setMediaRetryKey(retryable ? previewKey : null);
        }
      });
    return () => controller.abort();
  }, [mediaFailureKey, mediaSource, previewKey, emptyMedia]);

  useEffect(() => {
    setMediaFailureKey(null);
    setMediaFailureMessage(null);
    setMediaRetryKey(null);
    setMediaAttempt(0);
    setSaveFailure(null);
  }, [previewKey]);

  if (!item || index === null) return null;

  const metadata = item.byteSize === null ? null : formatFileSize(item.byteSize);
  const canPreview = item.availability !== "missing" && item.availability !== "unavailable";
  const canSave = canPreview && (localFile !== undefined || item.originalUrl !== null);
  const multiItem = items.length > 1;
  const imageGallery = items.every(attachment => attachment.source.kind === "markdown-image");
  const saveMessage = saveFailure?.key === previewKey ? saveFailure.message : null;
  const text = textState?.key === previewKey ? textState : null;
  const textFormat = item.previewKind === "text" ? attachmentTextFormat(item) : null;
  const mediaFailure = mediaFailureKey === previewKey
    ? {
      message: mediaFailureMessage ?? "미리보기를 불러오지 못했습니다.",
      retryable: mediaRetryKey === previewKey,
    }
    : null;
  const extension = item.name?.includes(".") ? item.name.split(".").pop()!.toUpperCase() : "FILE";
  // The popup frame follows the content kind: documents read at the document
  // width, images and videos at their own size, HTML and audio keep the stable
  // viewport frame, and files without a preview fit their state text.
  const contentKind = item.previewKind === "image"
    ? "image"
    : item.previewKind === "text"
      ? textFormat === "html" ? "html" : "document"
      : mediaFormat === "video" ? "video"
        : mediaFormat === "audio" ? "audio"
          : "file";
  // Galleries pick one frame for the whole bundle. A bundle of markdown/plain
  // documents reads at the document width; any other mix keeps the full frame.
  const bundleKind = !multiItem ? null
    : items.every(attachment => {
        const format = attachment.previewKind === "text" ? attachmentTextFormat(attachment) : null;
        return format === "markdown" || format === "plain";
      }) ? "documents" : "mixed";

  const changeIndex = (next: number) => {
    if (!multiItem || next < 0 || next >= items.length || next === index) return;
    onIndexChange(next);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!multiItem || event.target instanceof HTMLMediaElement) return;
    const viewport = imageViewer.viewportRef.current;
    const inReadingFrame = viewport?.contains(event.target as Node) ?? false;
    // The focused reading frame scrolls on the same keys the design says it
    // should. The browser does not do this reliably inside a dialog, so the
    // frame moves here. Left/Right keep the main gallery behaviour (step) in
    // a vertical frame and scroll sideways in a horizontal one.
    const line = 40;
    const frameSize = imageViewer.reading?.axis === "x" ? viewport?.clientWidth : viewport?.clientHeight;
    const page = Math.max(line, Math.round((frameSize ?? 0) * 0.9));
    const moves: Record<string, number | "home" | "end"> = imageViewer.reading?.axis === "x"
      ? {
          ArrowLeft: -line, ArrowRight: line, PageDown: page, PageUp: -page,
          " ": event.shiftKey ? -page : page, Home: "home", End: "end",
        }
      : inReadingFrame
        ? {
            ArrowDown: line, ArrowUp: -line, PageDown: page, PageUp: -page,
            " ": event.shiftKey ? -page : page, Home: "home", End: "end",
          }
        : {};
    const move = inReadingFrame ? moves[event.key] : undefined;
    if (move !== undefined && viewport) {
      event.preventDefault();
      if (imageViewer.reading?.axis === "x") {
        viewport.scrollLeft = move === "home" ? 0
          : move === "end" ? viewport.scrollWidth
            : viewport.scrollLeft + move;
      } else {
        viewport.scrollTop = move === "home" ? 0
          : move === "end" ? viewport.scrollHeight
            : viewport.scrollTop + move;
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      changeIndex(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      changeIndex(index + 1);
    }
  };
  const saveOriginal = async () => {
    setSaveFailure(null);
    setSaving(true);
    try {
      if (localFile) downloadLocalAttachmentOriginal(localFile);
      else if (item.originalUrl && item.name) await downloadAttachmentOriginal({ url: item.originalUrl, filename: item.name });
      else throw new Error("Original attachment is unavailable");
    } catch (error) {
      setSaveFailure({ key: previewKey, message: saveErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPopup
        ref={popupRef}
        initialFocus={popupRef}
        className="v3-surface image-viewer-popup chat-image-viewer-popup"
        data-attachment-kind={contentKind}
        {...(contentKind === "image" ? imageViewer.popupAttributes : {})}
        {...(contentKind === "image" ? { style: imageViewer.popupStyle } : {})}
        {...(bundleKind ? { "data-attachment-bundle": bundleKind } : {})}
        {...(returnFocus ? { finalFocus: () => returnFocus } : {})}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="chat-image-viewer-header">
          <DialogTitle data-slot="attachment-name" className="chat-image-viewer-title">{item.name ?? "첨부 파일"}</DialogTitle>
          {metadata && <p className="chat-image-viewer-metadata">{metadata}</p>}
        </DialogHeader>
        <DialogPanel
          scrollFade={false}
          scrollable={item.previewKind !== "image" && textFormat !== "html" && mediaFormat === null}
          className="chat-image-viewer-panel"
        >
          {panelContent ?? (item.availability === "missing" ? (
            <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">첨부를 찾을 수 없습니다.</div>
          ) : item.availability === "unavailable" ? (
            <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">첨부를 사용할 수 없습니다.</div>
          ) : item.previewKind === "image" ? (
            !imageSource ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">이미지 미리보기를 사용할 수 없습니다.</span>
              </div>
            ) : (
              <div className="attachment-viewer-image-body" data-image-state={imageViewer.state}>
                {imageViewer.state !== "failed" && (imageViewer.reading ? (
                  <ScrollArea
                    className="attachment-viewer-scroll"
                    {...imageViewer.scrollAreaProps}
                    viewportRef={imageViewer.viewportRef}
                    viewportProps={imageViewer.viewportProps}
                  >
                    <div ref={imageMediaRef} className="attachment-viewer-media">
                      <MarkdownImage
                        key={`${previewKey}:${imageViewer.attempt}`}
                        src={imageSource}
                        alt={item.source.kind === "markdown-image" ? item.source.alt : item.name ?? "첨부 이미지"}
                        mimeType={item.mimeType}
                        variant="chatRefined"
                        loading="eager"
                        className="attachment-viewer-image chat-image-viewer-image"
                        onLoad={() => imageViewer.onImageLoad()}
                        onError={() => imageViewer.onImageError()}
                      />
                    </div>
                  </ScrollArea>
                ) : (
                  <div ref={imageMediaRef} className="attachment-viewer-media">
                    <MarkdownImage
                      key={`${previewKey}:${imageViewer.attempt}`}
                      src={imageSource}
                      alt={item.source.kind === "markdown-image" ? item.source.alt : item.name ?? "첨부 이미지"}
                      mimeType={item.mimeType}
                      variant="chatRefined"
                      loading="eager"
                      className="attachment-viewer-image chat-image-viewer-image"
                      onLoad={() => imageViewer.onImageLoad()}
                      onError={() => imageViewer.onImageError()}
                    />
                  </div>
                ))}
                <AttachmentViewerImageStatus
                  state={imageViewer.state}
                  message="이미지를 불러오지 못했습니다."
                  retryable={imageViewer.retryable}
                  onRetry={imageViewer.retry}
                />
              </div>
            )
          ) : item.previewKind === "text" ? (
            !canPreview ? null : text?.state === "loading" || text === null ? (
              <div className="chat-attachment-state chat-image-status" role="status">미리보기를 불러오는 중…</div>
            ) : text.state === "error" ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">{text.message}</span>
                {text.retryable && <Button variant="outline" size="sm" onClick={() => setRetryCount(value => value + 1)}>다시 시도</Button>}
              </div>
            ) : text.result.text.length === 0 ? (
              <div className="chat-attachment-state chat-image-status" role="status">빈 파일</div>
            ) : (
              <>
                {textFormat === "markdown" ? (
                  <div className="chat-attachment-markdown" data-slot="attachment-preview-body">
                    <DocumentMarkdown content={text.result.text} />
                  </div>
                ) : textFormat === "html" ? (
                  <CustomViewIframe
                    html={withEscapeRelay(text.result.text)}
                    title={item.name ?? "HTML 첨부"}
                    className="chat-attachment-html-frame"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words" data-slot="attachment-preview-body">{text.result.text}</pre>
                )}
                {text.result.truncated && <p className="chat-image-status" role="status">파일이 커서 앞부분만 표시합니다.</p>}
              </>
            )
          ) : mediaFormat !== null ? (
            emptyMedia ? (
              <div className="chat-attachment-state chat-image-status" role="status">빈 파일</div>
            ) : mediaFailure ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">{mediaFailure.message}</span>
                {mediaFailure.retryable && <Button variant="outline" size="sm" onClick={() => {
                  setMediaFailureKey(null);
                  setMediaFailureMessage(null);
                  setMediaRetryKey(null);
                  setMediaAttempt(value => value + 1);
                }}>다시 시도</Button>}
              </div>
            ) : mediaSource === undefined && !localFile ? (
              <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">미리보기를 불러오지 못했습니다.</div>
            ) : (
              <div className="chat-attachment-media-frame">
                {mediaFormat === "video" ? (
                  <video
                    key={`${previewKey}:${mediaAttempt}`}
                    controls
                    playsInline
                    preload="metadata"
                    src={mediaSource}
                    aria-label={item.name ?? "첨부 동영상"}
                    className="chat-attachment-video-player"
                    onLoadedData={() => {
                      setMediaFailureKey(null);
                      setMediaFailureMessage(null);
                      setMediaRetryKey(null);
                    }}
                    onError={() => {
                      setMediaFailureMessage("미리보기를 불러오지 못했습니다.");
                      setMediaRetryKey(null);
                      setMediaFailureKey(previewKey);
                    }}
                  />
                ) : (
                  <audio
                    key={`${previewKey}:${mediaAttempt}`}
                    controls
                    preload="metadata"
                    src={mediaSource}
                    aria-label={item.name ?? "첨부 오디오"}
                    className="chat-attachment-audio-player"
                    onLoadedData={() => {
                      setMediaFailureKey(null);
                      setMediaFailureMessage(null);
                      setMediaRetryKey(null);
                    }}
                    onError={() => {
                      setMediaFailureMessage("미리보기를 불러오지 못했습니다.");
                      setMediaRetryKey(null);
                      setMediaFailureKey(previewKey);
                    }}
                  />
                )}
              </div>
            )
          ) : <div className="chat-attachment-state" role="status"><FileTypeIcon label={extension} /></div>)}
        </DialogPanel>
        {(multiItem || canSave || saveMessage) && (
          <DialogFooter className="chat-image-viewer-footer">
            {multiItem && (
              <div className="chat-image-viewer-navigation">
                <Button
                  aria-label={imageGallery ? "이전 이미지" : "이전 첨부"}
                  variant="ghost"
                  size="icon"
                  className="aria-disabled:opacity-64"
                  aria-disabled={index === 0}
                  onClick={() => changeIndex(index - 1)}
                ><ChevronLeft aria-hidden="true" /></Button>
                <span className="chat-image-viewer-count" style={{ width: `${String(items.length).length * 2 + 1}ch` }} aria-live="polite">{index + 1}/{items.length}</span>
                <Button
                  aria-label={imageGallery ? "다음 이미지" : "다음 첨부"}
                  variant="ghost"
                  size="icon"
                  className="aria-disabled:opacity-64"
                  aria-disabled={index === items.length - 1}
                  onClick={() => changeIndex(index + 1)}
                ><ChevronRight aria-hidden="true" /></Button>
              </div>
            )}
            {canSave && (
              <Button variant="outline" size="sm" className="chat-image-viewer-save max-sm:size-9 max-sm:px-0" aria-label={saving ? "저장 중…" : "원본 저장"} disabled={saving} onClick={() => void saveOriginal()}>
                <Download aria-hidden="true" />
                <span className="max-sm:sr-only">{saving ? "저장 중…" : "원본 저장"}</span>
              </Button>
            )}
            {saveMessage && <span className="chat-image-status chat-image-viewer-save-error" role="status" data-slot="dialog-error-message">{saveMessage}</span>}
          </DialogFooter>
        )}
        {contentKind === "image" && imageViewer.showToggle && (
          <AttachmentViewerFitToggle
            label={imageViewer.toggleLabel}
            icon={imageViewer.toggleIcon}
            onToggle={imageViewer.toggleFit}
          />
        )}
        {contentKind === "image" && (
          <AttachmentViewerProbes
            areaRef={imageViewer.areaProbeRef}
            referenceRef={imageViewer.referenceProbeRef}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
