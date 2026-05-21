export type ImageAttachmentMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

const IMAGE_MEDIA_TYPES: Record<string, ImageAttachmentMediaType> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function getImageAttachmentMediaType(path: string): ImageAttachmentMediaType | undefined {
  const pathname = path.split(/[?#]/, 1)[0] ?? path;
  const dotIndex = pathname.lastIndexOf(".");
  if (dotIndex < 0) return undefined;
  return IMAGE_MEDIA_TYPES[pathname.slice(dotIndex).toLowerCase()];
}

export function isImageAttachmentPath(path: string): boolean {
  return getImageAttachmentMediaType(path) !== undefined;
}
