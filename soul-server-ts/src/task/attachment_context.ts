import type { ContextItem } from "../context/prompt_assembler.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function isImageAttachmentPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] ?? path;
  const dotIndex = pathname.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return IMAGE_EXTENSIONS.has(pathname.slice(dotIndex).toLowerCase());
}

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

export function buildAttachmentContextItems(paths?: string[]): ContextItem[] {
  if (!paths || paths.length === 0) return [];
  return [
    {
      key: "attached_files",
      label: "첨부 파일",
      content:
        "다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n" +
        paths.map((path) => `- ${path}`).join("\n"),
    },
  ];
}
