import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";
import { ScrollArea } from "@seosoyoung/soul-ui/components/ui/scroll-area";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import {
  AttachmentViewerFitToggle,
  AttachmentViewerImageStatus,
  AttachmentViewerProbes,
  useAttachmentViewerImage,
} from "@seosoyoung/soul-ui/components/AttachmentViewerImage";
import { useHeicImageSource } from "@seosoyoung/soul-ui/lib/image-source";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import { registerDashboardReader } from "../pwa/dashboard-reload";

export interface CardImageSelection { src: string; alt: string; attachment?: ChatAttachmentItem }
export interface CardAttachmentStatus { message: string; onRetry?(): void }

/** Shared dialog surface for card timeline and check item evidence images. */
export function CardImageViewer({ image, attachments, attachmentStatus, returnFocus, onClose }: { image: CardImageSelection | null; attachments?: readonly ChatAttachmentItem[]; attachmentStatus?: Readonly<Record<string, CardAttachmentStatus>>; returnFocus?: HTMLElement | null; onClose(): void }) {
  const [attachmentCursor, setAttachmentCursor] = useState<{ key: string; index: number } | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const plainImage = image && !image.attachment ? image : null;
  const isOpen = image !== null;
  const imageViewer = useAttachmentViewerImage({
    popupRef,
    mediaRef,
    src: plainImage?.src,
    mimeType: null,
    label: plainImage?.alt || "이미지",
  });
  const heic = useHeicImageSource(plainImage?.src, null);
  const imageFailed = imageViewer.state === "failed";
  const attachmentItems = image?.attachment
    ? attachments?.length ? [...attachments] : [image.attachment]
    : [];
  const selectedAttachmentIndex = image?.attachment
    ? attachmentItems.findIndex(item => item.key === image.attachment!.key)
    : -1;
  const attachmentIndex = image?.attachment
    ? attachmentCursor?.key === image.attachment.key
      ? Math.min(attachmentCursor.index, attachmentItems.length - 1)
      : Math.max(0, selectedAttachmentIndex)
    : 0;

  useEffect(() => isOpen ? registerDashboardReader(() => {
    const popup = popupRef.current;
    return {
      footer: popup?.querySelector<HTMLElement>('[data-slot="dialog-footer"]'),
      content: popup?.dataset.attachmentKind === "document" ? popup.querySelector<HTMLElement>('[data-slot="dialog-panel"]') : null,
    };
  }) : undefined, [isOpen, Boolean(image?.attachment), attachmentIndex]);

  useEffect(() => {
    if (!image) setAttachmentCursor(null);
  }, [image]);

  useEffect(() => {
    if (!image || image.attachment) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [image, onClose]);

  if (image?.attachment) {
    const status=attachmentStatus?.[attachmentItems[attachmentIndex]!.key];
    return <AttachmentViewer
      items={attachmentItems}
      index={attachmentIndex}
      onIndexChange={index => setAttachmentCursor({ key: image.attachment!.key, index })}
      onClose={onClose}
      returnFocus={returnFocus}
      popupRef={popupRef}
      panelContent={status?<div className="chat-attachment-state chat-image-status" role="status"><span data-v3-selectable-content="true">{status.message}</span>{status.onRetry?<Button variant="outline" size="sm" onClick={status.onRetry}>다시 시도</Button>:null}</div>:undefined}
    />;
  }

  const viewerImage = !imageFailed && plainImage ? (
    <div ref={mediaRef} className="attachment-viewer-media">
      <div className="chat-image-frame">
        <img
          src={heic.displaySrc}
          alt={plainImage.alt}
          className="attachment-viewer-image max-w-full object-contain"
          onLoad={() => imageViewer.onImageLoad()}
          onError={() => {
            // A browser that cannot paint HEIC reports an error first; decode it
            // lazily and report only if that also fails.
            if (heic.tryDecode()) return;
            imageViewer.onImageError();
          }}
        />
      </div>
    </div>
  ) : null;

  return <Dialog open={Boolean(image)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup
      ref={popupRef}
      initialFocus={popupRef}
      className="v3-surface image-viewer-popup"
      {...imageViewer.popupAttributes}
      style={imageViewer.popupStyle}
      {...(returnFocus ? { finalFocus: () => returnFocus } : {})}
    >
      <DialogTitle className="sr-only">{image?.alt || "이미지"}</DialogTitle>
      {image ? <figure className="v3-card-image-expanded" data-image-failed={imageFailed || undefined}>
        <div className="attachment-viewer-image-body" data-image-state={imageViewer.state}>
          {imageViewer.state !== "failed" && (imageViewer.reading ? (
            <ScrollArea
              className="attachment-viewer-scroll"
              {...imageViewer.scrollAreaProps}
              viewportRef={imageViewer.viewportRef}
              viewportProps={imageViewer.viewportProps}
            >
              {viewerImage}
            </ScrollArea>
          ) : viewerImage)}
          <AttachmentViewerImageStatus
            state={imageViewer.state}
            message="파일을 불러오지 못했습니다"
            retryable={imageViewer.retryable}
            onRetry={imageViewer.retry}
          />
        </div>
        {image.alt ? <figcaption data-v3-selectable-content="true">{image.alt}</figcaption> : null}
      </figure> : null}
      {image && imageViewer.showToggle && (
        <AttachmentViewerFitToggle
          label={imageViewer.toggleLabel}
          icon={imageViewer.toggleIcon}
          onToggle={imageViewer.toggleFit}
        />
      )}
      {image && (
        <AttachmentViewerProbes
          areaRef={imageViewer.areaProbeRef}
          referenceRef={imageViewer.referenceProbeRef}
        />
      )}
    </DialogPopup>
  </Dialog>;
}
