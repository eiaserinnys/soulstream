import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { MarkdownImage } from "../MarkdownImage";
import {
  chatImageMetadataKey,
  getChatImageFilename,
  type ChatImageItem,
  type ChatImageMetadata,
  type ChatImageRole,
} from "../../lib/chat-markdown-images";

interface RemoteImageMetadata {
  filename?: string;
  mimeType?: string;
  bytes?: number;
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = value.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i)?.[1];
  const plain = value.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
  const candidate = encoded ?? plain?.[1] ?? plain?.[2]?.trim();
  if (!candidate) return undefined;
  const unquoted = candidate.replace(/^"|"$/g, "");
  try {
    return decodeURIComponent(unquoted);
  } catch {
    return unquoted;
  }
}

function isSameOriginProtectedImage(src: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(src, window.location.origin);
    return url.origin === window.location.origin && url.pathname === "/api/attachments/files";
  } catch {
    return false;
  }
}

function useImageMetadata(
  image: ChatImageItem,
  onMetadata: (key: string, metadata: ChatImageMetadata) => void,
): void {
  useEffect(() => {
    if (
      !isSameOriginProtectedImage(image.src)
      || (image.filename && image.mimeType && image.bytes !== undefined)
    ) return;

    const controller = new AbortController();
    void fetch(image.src, {
      method: "HEAD",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(response => {
      if (!response.ok) return;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      const contentLength = response.headers.get("content-length");
      const parsedBytes = contentLength && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : undefined;
      const value: RemoteImageMetadata = {
        filename: contentDispositionFilename(response.headers.get("content-disposition")),
        ...(contentType ? { mimeType: contentType } : {}),
        ...(parsedBytes !== undefined && Number.isSafeInteger(parsedBytes) ? { bytes: parsedBytes } : {}),
      };
      if (value.filename || value.mimeType || value.bytes !== undefined) {
        onMetadata(chatImageMetadataKey(image), value);
      }
    }).catch(() => {
      // Metadata is optional; the image request remains independent.
    });

    return () => controller.abort();
  }, [image.id, image.src, image.filename, image.mimeType, image.bytes, onMetadata]);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 100) return `${kilobytes.toFixed(1)} KB`;
  return `${Math.round(kilobytes)} KB`;
}

function imageMetaText(mimeType?: string, bytes?: number): string | undefined {
  const parts = [mimeType, bytes !== undefined ? formatBytes(bytes) : undefined].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

function ChatImageThumbnail({
  image,
  galleryIndex,
  metadata,
  onMetadata,
  onOpen,
}: {
  image: ChatImageItem;
  galleryIndex: number;
  metadata?: ChatImageMetadata;
  onMetadata(key: string, metadata: ChatImageMetadata): void;
  onOpen(index: number, trigger: HTMLElement): void;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useImageMetadata(image, onMetadata);
  const filename = image.filename ?? metadata?.filename ?? getChatImageFilename(image.src);
  const mimeType = image.mimeType ?? metadata?.mimeType;
  const bytes = image.bytes ?? metadata?.bytes;
  const meta = imageMetaText(mimeType, bytes);
  const failed = failedSource === image.src;

  return (
    <figure className="chat-image-card" data-chat-image-index={galleryIndex}>
      {failed ? (
        <span className="chat-image-status" role="status">이미지를 불러오지 못했습니다.</span>
      ) : (
        <MarkdownImage
          src={image.src}
          alt={image.alt}
          ariaLabel={filename ? `이미지 확대: ${filename}` : "이미지 확대"}
          variant="chatRefined"
          className="chat-image-thumbnail-image"
          onOpen={(_src, _alt, trigger) => onOpen(galleryIndex, trigger)}
          onLoad={src => setFailedSource(current => current === src ? null : current)}
          onError={src => setFailedSource(src)}
        />
      )}
      {(filename || meta) && (
        <figcaption className="chat-image-caption">
          {filename && <span className="chat-image-filename" title={filename}>{filename}</span>}
          {meta && <span className="chat-image-metadata">{meta}</span>}
        </figcaption>
      )}
    </figure>
  );
}

export function ChatImageAttachments({
  gallery,
  galleryIndexes,
  role,
  runId,
  metadataByImage,
  onMetadata,
  onOpen,
}: {
  gallery: ChatImageItem[];
  galleryIndexes: number[];
  role: ChatImageRole;
  runId: string;
  metadataByImage: Record<string, ChatImageMetadata>;
  onMetadata(key: string, metadata: ChatImageMetadata): void;
  onOpen(index: number, trigger: HTMLElement): void;
}) {
  if (galleryIndexes.length === 0) return null;
  return (
    <div
      className="chat-image-run"
      data-chat-image-run={runId}
      data-chat-image-count={galleryIndexes.length}
      data-chat-image-role={role}
    >
      <div className="chat-image-grid">
        {galleryIndexes.map(index => {
          const image = gallery[index];
          if (!image) return null;
          return (
            <ChatImageThumbnail
              key={`${image.id}:${image.src}`}
              image={image}
              galleryIndex={index}
              metadata={metadataByImage[chatImageMetadataKey(image)]}
              onMetadata={onMetadata}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ChatImageViewer({
  gallery,
  index,
  metadataByImage,
  onOpenChange,
  onIndexChange,
}: {
  gallery: ChatImageItem[];
  index: number;
  metadataByImage: Record<string, ChatImageMetadata>;
  onOpenChange(open: boolean): void;
  onIndexChange(index: number): void;
}) {
  const image = gallery[index];
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (!image) return null;

  const metadata = metadataByImage[chatImageMetadataKey(image)];
  const filename = image.filename ?? metadata?.filename ?? getChatImageFilename(image.src);
  const meta = imageMetaText(image.mimeType ?? metadata?.mimeType, image.bytes ?? metadata?.bytes);
  const multiImage = gallery.length > 1;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="chat-image-viewer-popup">
        <DialogHeader className="chat-image-viewer-header">
          <DialogTitle className="chat-image-viewer-title">{filename ?? "이미지"}</DialogTitle>
          {meta && <p className="chat-image-viewer-metadata">{meta}</p>}
        </DialogHeader>
        <DialogPanel scrollFade={false} scrollable={false} className="chat-image-viewer-panel">
          {failedSource === image.src ? (
            <span className="chat-image-status" role="status">이미지를 불러오지 못했습니다.</span>
          ) : (
            <MarkdownImage
              src={image.src}
              alt={image.alt}
              variant="chatRefined"
              loading="eager"
              className="chat-image-viewer-image"
              onLoad={src => setFailedSource(current => current === src ? null : current)}
              onError={src => setFailedSource(src)}
            />
          )}
        </DialogPanel>
        {multiImage && (
          <DialogFooter className="chat-image-viewer-footer">
            <Button
              aria-label="이전 이미지"
              variant="ghost"
              size="icon"
              disabled={index === 0}
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <span className="chat-image-viewer-count" aria-live="polite">{index + 1}/{gallery.length}</span>
            <Button
              aria-label="다음 이미지"
              variant="ghost"
              size="icon"
              disabled={index === gallery.length - 1}
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
