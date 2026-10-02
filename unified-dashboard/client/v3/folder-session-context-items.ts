import type { BlockDto } from "@seosoyoung/soul-ui/page";
import type { ProjectContextInheritance } from "./project-context-inheritance";
import { singleLinePreview } from "./session-preview";

export function buildFolderSessionContextItems(effectiveContext: ProjectContextInheritance,
  contextBlocks: readonly BlockDto[], folderPageId: string) {
  return [
    ...effectiveContext.guidance.map((guidance) => ({
      id: `${guidance.source.pageId}:${guidance.blockId}`,
      kind: "guidance" as const,
      blockId: guidance.blockId,
      direct: guidance.source.pageId === folderPageId,
      icon: "✦",
      contentLabel: singleLinePreview(guidance.text, 96) ?? guidance.text,
      sourceLabel: contextSourceLabel(guidance.source.folderName),
      label: `${singleLinePreview(guidance.text, 96) ?? guidance.text} · ${contextSourceLabel(guidance.source.folderName)}`,
    })),
    ...effectiveContext.atomReferences.map((reference) => ({
      id: `${reference.source.pageId}:${reference.blockId}`,
      kind: "atom" as const,
      blockId: reference.blockId,
      direct: reference.source.pageId === folderPageId,
      reference,
      icon: "⚛",
      contentLabel: reference.nodeTitle,
      sourceLabel: contextSourceLabel(reference.source.folderName),
      label: `${reference.nodeTitle} · ${contextSourceLabel(reference.source.folderName)}`,
    })),
    ...contextBlocks.flatMap((block) => {
      const match = /^\[\[([^\[\]]+)\]\]$/.exec(block.text.trim());
      return match ? [{
        id: block.id,
        kind: "page" as const,
        blockId: block.id,
        direct: true,
        icon: "📄",
        contentLabel: match[1],
        sourceLabel: "이 폴더",
        label: `${match[1]} · 이 폴더`,
      }] : [];
    }),
  ];
}

export function contextSourceLabel(folderName: string): string {
  return folderName === "이 폴더" ? folderName : `${folderName}에서 상속`;
}
