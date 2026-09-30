import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const USER_COPY_FILES = [
  "./PlannerFolderCard.tsx",
  "./RichSessionRow.tsx",
  "./SessionSuccessionModal.tsx",
  "./ProjectContextFormFields.tsx",
  "./FolderSessionHistory.tsx",
  "./FolderWorkspace.tsx",
  "./use-v3-planner-actions.ts",
  "./use-v3-planner-reads.ts",
];

describe("v3 session language", () => {
  it("does not expose the legacy run term in Korean user copy", () => {
    const source = USER_COPY_FILES
      .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/Run 히스토리|이전 Run|Run 불러오는|Run 채팅|선택된 run|run #|run 0|마지막 run|새 폴더 run|run 이동|\} run`/);
  });

  it("keeps shared context and per-session context on their canonical surfaces", () => {
    const contextForm = readFileSync(
      fileURLToPath(new URL("./ProjectContextFormFields.tsx", import.meta.url)),
      "utf8",
    );
    const succession = readFileSync(
      fileURLToPath(new URL("./SessionSuccessionModal.tsx", import.meta.url)),
      "utf8",
    );

    expect(contextForm).toContain("ProjectAtomFields");
    expect(contextForm).toContain("ProjectSessionDefaultsFields");
    expect(succession).toContain("보드 문서");
    expect(succession).toContain("atom 노드");
    expect(succession).not.toContain("추가 지침");
    expect(succession).toContain("초기 지시");
    expect(succession).not.toContain("기본 지침");
  });
});
