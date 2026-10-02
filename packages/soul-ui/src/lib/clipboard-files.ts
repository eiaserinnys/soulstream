/** Clipboard images join the same File upload path as selected attachments. */
const imageExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff",
  "image/x-icon": "ico",
};

export function extractClipboardFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items ?? [])
    .filter(item => item.kind === "file")
    .flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
  const fallback = Array.from(data.files ?? []);
  const itemImages = itemFiles.filter(file => file.type.startsWith("image/"));
  const images = itemImages.length ? itemImages : fallback.filter(file => file.type.startsWith("image/"));
  const otherFiles = (fallback.length ? fallback : itemFiles).filter(file => !file.type.startsWith("image/"));
  return [...new Set([...images, ...otherFiles])].map(file => {
    if (!file.type.startsWith("image/")) return file;
    const genericName = !file.name.includes(".") || /^(image|clipboard|pasted[-_ ]?image|blob|unnamed)(\.[^.]+)?$/i.test(file.name);
    if (!genericName) return file;
    const extension = imageExtensions[file.type] ?? file.type.slice("image/".length).replace(/[^a-z0-9]/gi, "");
    return new File([file], `clipboard-${crypto.randomUUID()}.${extension}`, {
      type: file.type, lastModified: file.lastModified,
    });
  });
}

export function handleClipboardFiles(
  event: { clipboardData: DataTransfer; preventDefault(): void },
  addFiles: (files: File[]) => void,
): void {
  const files = extractClipboardFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
}
