"use client";

import type { dictionaries } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
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

type AttachmentMessageKey = `ui.attachment.${keyof typeof dictionaries.ko.ui.attachment}`;

type TextState =
  | { key: string; state: "loading" }
  | { key: string; state: "ready"; result: AttachmentTextPreview }
  | { key: string; state: "error"; messageKey: AttachmentMessageKey; retryable: boolean };

function canRetryError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof AttachmentTextPreviewError
    && error.status !== null && error.status >= 500);
}

function textErrorKey(error: unknown): AttachmentMessageKey {
  if (error instanceof AttachmentTextPreviewError) {
    if (error.code === "TEXT_PREVIEW_UNSUPPORTED_ENCODING") return "ui.attachment.unsupportedEncoding";
    if (error.status === 401 || error.status === 403) return "ui.attachment.unreadable";
    if (error.status === 404) return "ui.attachment.notFound";
    if (error.status !== null && error.status >= 500) return "ui.attachment.fetchFailed";
  }
  return "ui.attachment.previewFailed";
}

function mediaError(status: number): { messageKey: AttachmentMessageKey; retryable: boolean } {
  if (status === 401 || status === 403) {
    return { messageKey: "ui.attachment.unreadable", retryable: false };
  }
  if (status === 404) return { messageKey: "ui.attachment.notFound", retryable: false };
  if (status >= 500) return { messageKey: "ui.attachment.fetchFailed", retryable: true };
  return { messageKey: "ui.attachment.previewFailed", retryable: false };
}

function saveErrorKey(error: unknown): AttachmentMessageKey {
  if (error instanceof AttachmentDownloadError && (error.status === 401 || error.status === 403)) {
    return "ui.attachment.cannotSave";
  }
  return "ui.attachment.cannotSaveOriginal";
}

export function AttachmentViewer({
  items,
  index,
  onIndexChange,
  onClose,
  returnFocus,
  panelContent,
  popupRef: externalPopupRef,
  onPopupChange,
}: {
  items: ChatAttachmentItem[];
  index: number | null;
  onIndexChange(index: number): void;
  onClose(): void;
  returnFocus?: HTMLElement | null;
  panelContent?: ReactNode;
  popupRef?: RefObject<HTMLDivElement | null>;
  onPopupChange?(): void;
}): ReactNode {
  const { t } = useTranslation();
  const item = index === null ? undefined : items[index];
  const localFile = item?.source.kind === "local" ? item.source.file : undefined;
  const mediaFormat = item ? attachmentMediaFormat(item) : null;
  const previewKey = item
    ? JSON.stringify([item.key, item.previewUrl, item.byteSize, item.mimeType, localFile?.name, localFile?.size])
    : "";
  const localPopupRef = useRef<HTMLDivElement>(null);
  const popupRef = externalPopupRef ?? localPopupRef;
  const setPopupRef = useCallback((popup: HTMLDivElement | null) => {
    popupRef.current = popup;
    onPopupChange?.();
  }, [popupRef, onPopupChange]);
  const imageMediaRef = useRef<HTMLDivElement>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [textState, setTextState] = useState<TextState | null>(null);
  const [mediaFailureKey, setMediaFailureKey] = useState<string | null>(null);
  const [mediaErrorMessageKey, setMediaErrorMessageKey] = useState<AttachmentMessageKey | null>(null);
  const [mediaRetryKey, setMediaRetryKey] = useState<string | null>(null);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [localPreview, setLocalPreview] = useState<{ key: string; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<{ key: string; messageKey: AttachmentMessageKey } | null>(null);

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
        const messageKey = item.availability === "missing"
          ? "ui.attachment.notFound"
          : item.availability === "unavailable"
            ? "ui.attachment.unavailable"
            : textErrorKey(error);
        setTextState({ key: previewKey, state: "error", messageKey, retryable: canRetryError(error) });
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
    label: item?.name ?? t("ui.attachment.image"),
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
          setMediaErrorMessageKey(failure.messageKey);
          setMediaRetryKey(failure.retryable ? previewKey : null);
        }
        await response.body?.cancel();
      }).catch(error => {
        if (!controller.signal.aborted) {
          const retryable = error instanceof TypeError;
          setMediaErrorMessageKey(retryable ? "ui.attachment.fetchFailed" : "ui.attachment.previewFailed");
          setMediaRetryKey(retryable ? previewKey : null);
        }
      });
    return () => controller.abort();
  }, [mediaFailureKey, mediaSource, previewKey, emptyMedia]);

  useEffect(() => {
    setMediaFailureKey(null);
    setMediaErrorMessageKey(null);
    setMediaRetryKey(null);
    setMediaAttempt(0);
    setSaveFailure(null);
  }, [previewKey]);

  if (!item || index === null) return null;

  const text = textState?.key === previewKey ? textState : null;
  const byteSize = item.byteSize ?? (text?.state === "ready" ? text.result.totalBytes : null);
  const metadata = byteSize === null ? null : formatFileSize(byteSize);
  const canPreview = item.availability !== "missing" && item.availability !== "unavailable";
  const canSave = canPreview && (localFile !== undefined || item.originalUrl !== null);
  const multiItem = items.length > 1;
  const imageGallery = items.every(attachment => attachment.source.kind === "markdown-image");
  const saveMessage = saveFailure?.key === previewKey ? t(saveFailure.messageKey) : null;
  const textFormat = item.previewKind === "text" ? attachmentTextFormat(item) : null;
  const mediaFailure = mediaFailureKey === previewKey
    ? {
      message: t(mediaErrorMessageKey ?? "ui.attachment.previewFailed"),
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
      setSaveFailure({ key: previewKey, messageKey: saveErrorKey(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPopup
        ref={setPopupRef}
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
          <DialogTitle data-slot="attachment-name" className="chat-image-viewer-title">{item.name ?? t("ui.attachment.file")}</DialogTitle>
          {metadata && <p className="chat-image-viewer-metadata">{metadata}</p>}
        </DialogHeader>
        <DialogPanel
          scrollFade={false}
          scrollable={item.previewKind !== "image" && textFormat !== "html" && mediaFormat === null}
          tabIndex={item.previewKind === "text" && textFormat !== "html" ? 0 : undefined}
          className="chat-image-viewer-panel focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          {panelContent ?? (item.availability === "missing" ? (
            <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">{t("ui.attachment.notFound")}</div>
          ) : item.availability === "unavailable" ? (
            <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">{t("ui.attachment.unavailable")}</div>
          ) : item.previewKind === "image" ? (
            !imageSource ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">{t("ui.attachment.imagePreviewUnavailable")}</span>
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
                        alt={item.source.kind === "markdown-image" ? item.source.alt : item.name ?? t("ui.attachment.image")}
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
                      alt={item.source.kind === "markdown-image" ? item.source.alt : item.name ?? t("ui.attachment.image")}
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
                  message={t("ui.attachment.imageFailed")}
                  retryable={imageViewer.retryable}
                  onRetry={imageViewer.retry}
                />
              </div>
            )
          ) : item.previewKind === "text" ? (
            !canPreview ? null : text?.state === "loading" || text === null ? (
              <div className="chat-attachment-state chat-image-status" role="status">{t("ui.attachment.previewLoading")}</div>
            ) : text.state === "error" ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">{t(text.messageKey)}</span>
                {text.retryable && <Button variant="outline" size="sm" onClick={() => setRetryCount(value => value + 1)}>{t("ui.common.retry")}</Button>}
              </div>
            ) : text.result.text.length === 0 ? (
              <div className="chat-attachment-state chat-image-status" role="status">{t("ui.attachment.emptyFile")}</div>
            ) : (
              <>
                {textFormat === "markdown" ? (
                  <div className="chat-attachment-markdown" data-slot="attachment-preview-body">
                    <DocumentMarkdown content={text.result.text} />
                  </div>
                ) : textFormat === "html" ? (
                  <CustomViewIframe
                    html={withEscapeRelay(text.result.text)}
                    title={item.name ?? t("ui.attachment.html")}
                    className="chat-attachment-html-frame"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words" data-slot="attachment-preview-body">{text.result.text}</pre>
                )}
                {text.result.truncated && <p className="chat-image-status" role="status">{t("ui.attachment.partialPreview")}</p>}
              </>
            )
          ) : mediaFormat !== null ? (
            emptyMedia ? (
              <div className="chat-attachment-state chat-image-status" role="status">{t("ui.attachment.emptyFile")}</div>
            ) : mediaFailure ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span data-slot="dialog-error-message">{mediaFailure.message}</span>
                {mediaFailure.retryable && <Button variant="outline" size="sm" onClick={() => {
                  setMediaFailureKey(null);
                  setMediaErrorMessageKey(null);
                  setMediaRetryKey(null);
                  setMediaAttempt(value => value + 1);
                }}>{t("ui.common.retry")}</Button>}
              </div>
            ) : mediaSource === undefined && !localFile ? (
              <div className="chat-attachment-state chat-image-status" role="status" data-slot="dialog-error-message">{t("ui.attachment.previewFailed")}</div>
            ) : (
              <div className="chat-attachment-media-frame">
                {mediaFormat === "video" ? (
                  <video
                    key={`${previewKey}:${mediaAttempt}`}
                    controls
                    playsInline
                    preload="metadata"
                    src={mediaSource}
                    aria-label={item.name ?? t("ui.attachment.video")}
                    className="chat-attachment-video-player"
                    onLoadedData={() => {
                      setMediaFailureKey(null);
                      setMediaErrorMessageKey(null);
                      setMediaRetryKey(null);
                    }}
                    onError={() => {
                      setMediaErrorMessageKey("ui.attachment.previewFailed");
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
                    aria-label={item.name ?? t("ui.attachment.audio")}
                    className="chat-attachment-audio-player"
                    onLoadedData={() => {
                      setMediaFailureKey(null);
                      setMediaErrorMessageKey(null);
                      setMediaRetryKey(null);
                    }}
                    onError={() => {
                      setMediaErrorMessageKey("ui.attachment.previewFailed");
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
                  aria-label={imageGallery ? t("ui.attachment.previousImage") : t("ui.attachment.previous")}
                  variant="ghost"
                  size="icon"
                  className="aria-disabled:opacity-64"
                  aria-disabled={index === 0}
                  onClick={() => changeIndex(index - 1)}
                ><ChevronLeft aria-hidden="true" /></Button>
                <span className="chat-image-viewer-count" style={{ width: `${String(items.length).length * 2 + 1}ch` }} aria-live="polite">{index + 1}/{items.length}</span>
                <Button
                  aria-label={imageGallery ? t("ui.attachment.nextImage") : t("ui.attachment.next")}
                  variant="ghost"
                  size="icon"
                  className="aria-disabled:opacity-64"
                  aria-disabled={index === items.length - 1}
                  onClick={() => changeIndex(index + 1)}
                ><ChevronRight aria-hidden="true" /></Button>
              </div>
            )}
            {canSave && (
              <Button variant="outline" size="sm" className="chat-image-viewer-save max-sm:size-9 max-sm:px-0" aria-label={saving ? t("ui.attachment.saving") : t("ui.attachment.saveOriginal")} disabled={saving} onClick={() => void saveOriginal()}>
                <Download aria-hidden="true" />
                <span className="max-sm:sr-only">{saving ? t("ui.attachment.saving") : t("ui.attachment.saveOriginal")}</span>
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
