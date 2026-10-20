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
import { FileTypeIcon } from "./FileAttachmentPreview";
import { formatFileSize } from "../lib/format-file-size";
import { MarkdownImage } from "./MarkdownImage";
import { downloadAttachmentOriginal, downloadLocalAttachmentOriginal } from "../lib/attachment-download";
import { readAttachmentText, readLocalAttachmentText, type AttachmentTextPreview } from "../lib/attachment-text-preview";
import { AttachmentDownloadError } from "../lib/attachment-download";
import { AttachmentTextPreviewError } from "../lib/attachment-text-preview";
import { attachmentTextFormat, type ChatAttachmentItem } from "../lib/chat-attachment-model";
import { MarkdownContent } from "./MarkdownContent";
import { CustomViewIframe } from "../custom-view/CustomViewRenderer";

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
  const previewKey = item
    ? JSON.stringify([item.key, item.previewUrl, item.byteSize, localFile?.name, localFile?.size])
    : "";
  const popupRef = useRef<HTMLDivElement>(null);
  const [imageRetryKey, setImageRetryKey] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [textState, setTextState] = useState<TextState | null>(null);
  const [imageFailureKey, setImageFailureKey] = useState<string | null>(null);
  const [imageAttempt, setImageAttempt] = useState(0);
  const [localImage, setLocalImage] = useState<{ key: string; url: string } | null>(null);
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
        : item.previewUrl !== null && item.byteSize !== null
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
    if (!item || item.previewKind !== "image" || !localFile || item.previewUrl !== null) {
      setLocalImage(null);
      return;
    }
    const url = URL.createObjectURL(localFile);
    setLocalImage({ key: previewKey, url });
    return () => URL.revokeObjectURL(url);
  }, [item?.key, item?.previewKind, item?.previewUrl, localFile, previewKey]);

  const imageSource = item?.previewUrl
    ?? (item?.source.kind === "markdown-image" ? item.source.src : undefined)
    ?? (localImage?.key === previewKey ? localImage.url : undefined);

  // Image error events omit the HTTP status. Probe only a failed remote source
  // to offer retry for server/network failures, never for forbidden/missing files.
  useEffect(() => {
    if (imageFailureKey !== previewKey || !imageSource || imageSource.startsWith("blob:")) return;
    const controller = new AbortController();
    void fetch(imageSource, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!controller.signal.aborted) setImageRetryKey(response.status >= 500 ? previewKey : null);
        await response.body?.cancel();
      }).catch(error => {
        if (!controller.signal.aborted && error instanceof TypeError) setImageRetryKey(previewKey);
      });
    return () => controller.abort();
  }, [imageFailureKey, imageSource, previewKey]);

  useEffect(() => {
    setImageFailureKey(null);
    setImageRetryKey(null);
    setImageAttempt(0);
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
  const extension = item.name?.includes(".") ? item.name.split(".").pop()!.toUpperCase() : "FILE";

  const changeIndex = (next: number) => {
    if (!multiItem || next < 0 || next >= items.length || next === index) return;
    onIndexChange(next);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!multiItem) return;
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
        {...(returnFocus ? { finalFocus: () => returnFocus } : {})}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="chat-image-viewer-header">
          <DialogTitle className="chat-image-viewer-title">{item.name ?? "첨부 파일"}</DialogTitle>
          {metadata && <p className="chat-image-viewer-metadata">{metadata}</p>}
        </DialogHeader>
        <DialogPanel
          scrollFade={false}
          scrollable={item.previewKind !== "image" && textFormat !== "html"}
          className="chat-image-viewer-panel"
        >
          {panelContent ?? (item.availability === "missing" ? (
            <div className="chat-attachment-state chat-image-status" role="status">첨부를 찾을 수 없습니다.</div>
          ) : item.availability === "unavailable" ? (
            <div className="chat-attachment-state chat-image-status" role="status">첨부를 사용할 수 없습니다.</div>
          ) : item.previewKind === "image" ? (
            imageFailureKey === previewKey || !imageSource ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span>{imageFailureKey === previewKey ? "이미지를 불러오지 못했습니다." : "이미지 미리보기를 사용할 수 없습니다."}</span>
                {imageRetryKey === previewKey && <Button variant="outline" size="sm" onClick={() => {
                  setImageFailureKey(null);
                  setImageAttempt(value => value + 1);
                }}>다시 시도</Button>}
              </div>
            ) : (
              <MarkdownImage
                key={`${previewKey}:${imageAttempt}`}
                src={imageSource}
                alt={item.source.kind === "markdown-image" ? item.source.alt : item.name ?? "첨부 이미지"}
                variant="chatRefined"
                loading="eager"
                className="chat-image-viewer-image"
                onLoad={() => setImageFailureKey(null)}
                onError={() => setImageFailureKey(previewKey)}
              />
            )
          ) : item.previewKind === "text" ? (
            !canPreview ? null : text?.state === "loading" || text === null ? (
              <div className="chat-attachment-state chat-image-status" role="status">미리보기를 불러오는 중…</div>
            ) : text.state === "error" ? (
              <div className="chat-attachment-state chat-image-status" role="status">
                <span>{text.message}</span>
                {text.retryable && <Button variant="outline" size="sm" onClick={() => setRetryCount(value => value + 1)}>다시 시도</Button>}
              </div>
            ) : text.result.text.length === 0 ? (
              <div className="chat-attachment-state chat-image-status" role="status">빈 파일</div>
            ) : (
              <>
                {textFormat === "markdown" ? (
                  <MarkdownContent content={text.result.text} codeBlockLayout="document" />
                ) : textFormat === "html" ? (
                  <CustomViewIframe
                    html={text.result.text}
                    title={item.name ?? "HTML 첨부"}
                    className="chat-attachment-html-frame"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words">{text.result.text}</pre>
                )}
                {text.result.truncated && <p className="chat-image-status" role="status">파일이 커서 앞부분만 표시합니다.</p>}
              </>
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
            {saveMessage && <span className="chat-image-status chat-image-viewer-save-error" role="status">{saveMessage}</span>}
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
