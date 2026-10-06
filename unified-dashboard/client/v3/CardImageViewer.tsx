import { useEffect } from "react";
import { Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";

export interface CardImageSelection { src: string; alt: string }

/** Shared dialog surface for card timeline and check item evidence images. */
export function CardImageViewer({ image, onClose }: { image: CardImageSelection | null; onClose(): void }) {
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
    <DialogPopup className="v3-surface">
      <DialogTitle className="sr-only">{image?.alt || "이미지"}</DialogTitle>
      {image ? <figure className="v3-card-image-expanded"><img src={image.src} alt={image.alt} className="max-w-full object-contain"/>{image.alt?<figcaption>{image.alt}</figcaption>:null}</figure> : null}
    </DialogPopup>
  </Dialog>;
}
