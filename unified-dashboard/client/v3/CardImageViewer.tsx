import { Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";

export interface CardImageSelection { src: string; alt: string }

/** Shared dialog surface for card timeline and check item evidence images. */
export function CardImageViewer({ image, onClose }: { image: CardImageSelection | null; onClose(): void }) {
  return <Dialog open={Boolean(image)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPopup>
      <DialogTitle className="sr-only">{image?.alt || "이미지"}</DialogTitle>
      {image ? <img src={image.src} alt={image.alt} className="max-w-full object-contain"/> : null}
    </DialogPopup>
  </Dialog>;
}
