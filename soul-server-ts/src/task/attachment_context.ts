import { isImageAttachmentPath } from "../attachments/image_media.js";

export { isImageAttachmentPath } from "../attachments/image_media.js";

export function splitAttachmentPaths(paths?: string[]): {
  imagePaths: string[];
  nonImagePaths: string[];
} {
  const imagePaths: string[] = [];
  const nonImagePaths: string[] = [];
  for (const path of paths ?? []) {
    if (isImageAttachmentPath(path)) {
      imagePaths.push(path);
    } else {
      nonImagePaths.push(path);
    }
  }
  return { imagePaths, nonImagePaths };
}
