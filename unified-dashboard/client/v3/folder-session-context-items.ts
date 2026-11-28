import { translateFolderFallback, type FolderTranslate } from "./folder-messages";
import type { BlockDto } from "../../../packages/page-model/src/types";
import type { ProjectContextInheritance } from "./project-context-inheritance";
import { singleLinePreview } from "./session-preview";

export function buildFolderSessionContextItems(effectiveContext: ProjectContextInheritance,
  contextBlocks: readonly BlockDto[], folderPageId: string, t: FolderTranslate = translateFolderFallback) {
  return [
    ...effectiveContext.guidance.map((guidance) => ({
      id: `${guidance.source.pageId}:${guidance.blockId}`,
      kind: "guidance" as const,
      blockId: guidance.blockId,
      direct: guidance.source.pageId === folderPageId,
      icon: "✦",
      contentLabel: singleLinePreview(guidance.text, 96) ?? guidance.text,
      sourceLabel: contextSourceLabel(guidance.source.folderName, t),
      label: `${singleLinePreview(guidance.text, 96) ?? guidance.text} · ${contextSourceLabel(guidance.source.folderName, t)}`,
    })),
    ...effectiveContext.atomReferences.map((reference) => ({
      id: `${reference.source.pageId}:${reference.blockId}`,
      kind: "atom" as const,
      blockId: reference.blockId,
      direct: reference.source.pageId === folderPageId,
      reference,
      icon: "⚛",
      contentLabel: reference.nodeTitle,
      sourceLabel: contextSourceLabel(reference.source.folderName, t),
      label: `${reference.nodeTitle} · ${contextSourceLabel(reference.source.folderName, t)}`,
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
        sourceLabel: t("folders.context.thisFolder"),
        label: t("folders.context.pageLabel", { name: match[1] }),
      }] : [];
    }),
  ];
}

function contextSourceLabel(folderName: string, t: FolderTranslate): string {
  return folderName === "이 폴더" ? t("folders.context.thisFolder") : t("folders.context.inherited", { name: folderName }); // i18n-ignore: Current-folder marker produced by FolderDetailPane and prepare-session-menu-succession
}
