import type { ContextItem } from "../context/prompt_assembler.js";

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
