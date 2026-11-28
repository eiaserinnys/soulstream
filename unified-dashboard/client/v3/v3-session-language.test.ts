import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { dictionaries } from "@soulstream/i18n";

const USER_COPY_FILES = [
  "./PlannerFolderCard.tsx",
  "./RichSessionRow.tsx",
  "./SessionSuccessionModal.tsx",
  "./ProjectDialog.tsx",
  "./FolderContextParts.tsx",
  "./FolderSessionHistory.tsx",
  "./FolderWorkspace.tsx",
  "./use-v3-planner-actions.ts",
  "./use-v3-planner-reads.ts",
];

describe("v3 session language", () => {
  it("does not expose the legacy run term in Korean user copy", () => {
    const source = USER_COPY_FILES
      .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"))
      .concat(Object.values(dictionaries.ko.sessions))
      .join("\n");

    expect(source).not.toMatch(/Run 히스토리|이전 Run|Run 불러오는|Run 채팅|선택된 run|run #|run 0|마지막 run|새 폴더 run|run 이동|\} run`/);
  });

  it("keeps shared context and per-session context on their canonical surfaces", () => {
    const succession = readFileSync(
      fileURLToPath(new URL("./SessionSuccessionModal.tsx", import.meta.url)),
      "utf8",
    );

    expect(succession).toContain('<strong>{t("sessions.boardDocuments")}</strong>');
    expect(succession).toContain("<ReferencePicker request={atomRequest} value={atomDraft.value}");
    expect(succession).toContain('<strong>{t("sessions.references")}</strong>');
    expect(succession).toMatch(/atomNodes: references\.map\(/);
    expect(succession).toMatch(/contextItems: contextSelection\.contextItems\.length > 0\s*\?\s*contextSelection\.contextItems\s*:\s*undefined/);
    expect(succession).not.toContain("추가 지침");
    expect(succession).toContain('aria-label={t("sessions.initialInstruction")}');
    expect(succession).not.toContain("기본 지침");
  });
});
