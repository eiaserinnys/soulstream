import { useEffect, useState } from "react";
import { Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";

export interface CardImageSelection { src: string; alt: string }

/** Shared dialog surface for card timeline and check item evidence images. */
export function CardImageViewer({ image, onClose }: { image: CardImageSelection | null; onClose(): void }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageFailed = Boolean(image && failedSrc === image.src);

  useEffect(() => {
    setFailedSrc(null);
  }, [image?.src]);

  useEffect(() => {
    if (!image) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [image, onClose]);

  return <Dialog open={Boolean(image)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup className="v3-surface image-viewer-popup">
      <DialogTitle className="sr-only">{image?.alt || "이미지"}</DialogTitle>
      {image ? <figure className="v3-card-image-expanded" data-image-failed={imageFailed || undefined}>{imageFailed?null:<img src={image.src} alt={image.alt} className="max-w-full object-contain" onError={()=>setFailedSrc(image.src)}/>}{image.alt||imageFailed?<figcaption>{imageFailed?"파일을 불러오지 못했습니다":image.alt}</figcaption>:null}</figure> : null}
    </DialogPopup>
  </Dialog>;
}
