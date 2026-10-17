import { useEffect, useState } from "react";
import { Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";
import { AttachmentViewer } from "@seosoyoung/soul-ui/components/AttachmentViewer";
import type { ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";

export interface CardImageSelection { src: string; alt: string; attachment?: ChatAttachmentItem }

/** Shared dialog surface for card timeline and check item evidence images. */
export function CardImageViewer({ image, attachments, returnFocus, onClose }: { image: CardImageSelection | null; attachments?: readonly ChatAttachmentItem[]; returnFocus?: HTMLElement | null; onClose(): void }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [attachmentCursor, setAttachmentCursor] = useState<{ key: string; index: number } | null>(null);
  const imageFailed = Boolean(image && failedSrc === image.src);
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

  useEffect(() => {
    setFailedSrc(null);
  }, [image?.src]);

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
    return <AttachmentViewer
      items={attachmentItems}
      index={attachmentIndex}
      onIndexChange={index => setAttachmentCursor({ key: image.attachment!.key, index })}
      onClose={onClose}
      returnFocus={returnFocus}
    />;
  }

  return <Dialog open={Boolean(image)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup className="v3-surface image-viewer-popup" {...(returnFocus ? { finalFocus: () => returnFocus } : {})}>
      <DialogTitle className="sr-only">{image?.alt || "이미지"}</DialogTitle>
      {image ? <figure className="v3-card-image-expanded" data-image-failed={imageFailed || undefined}>{imageFailed?null:<img src={image.src} alt={image.alt} className="max-w-full object-contain" onError={()=>setFailedSrc(image.src)}/>}{image.alt||imageFailed?<figcaption>{imageFailed?"파일을 불러오지 못했습니다":image.alt}</figcaption>:null}</figure> : null}
    </DialogPopup>
  </Dialog>;
}
