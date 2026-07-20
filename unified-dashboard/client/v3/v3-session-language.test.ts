import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const USER_COPY_FILES = [
  "./PlannerTaskCard.tsx",
  "./RichSessionRow.tsx",
  "./SessionSuccessionModal.tsx",
  "./TaskContextPicker.tsx",
  "./TaskRunHistory.tsx",
  "./TaskWorkspace.tsx",
  "./use-v3-planner-actions.ts",
  "./use-v3-planner-reads.ts",
];

describe("v3 session language", () => {
  it("does not expose the legacy run term in Korean user copy", () => {
    const source = USER_COPY_FILES
      .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/Run 히스토리|이전 Run|Run 불러오는|Run 채팅|선택된 run|run #|run 0|마지막 run|새 업무 run|run 이동|\} run`/);
  });

  it("keeps shared context and per-session context on their canonical surfaces", () => {
    const picker = readFileSync(
      fileURLToPath(new URL("./TaskContextPicker.tsx", import.meta.url)),
      "utf8",
    );
    const succession = readFileSync(
      fileURLToPath(new URL("./SessionSuccessionModal.tsx", import.meta.url)),
      "utf8",
    );

    expect(picker).toContain("AtomNodeSelector");
    expect(picker).not.toContain("상속됨(프로젝트에서)");
    expect(picker).not.toContain('id: "session"');
    expect(picker).not.toContain('id: "guidance"');
    expect(picker).not.toContain("atom nodeId 입력");
    expect(succession).toContain("보드 문서");
    expect(succession).toContain("atom 노드");
    expect(succession).not.toContain("추가 지침");
    expect(succession).toContain("초기 지시");
    expect(succession).not.toContain("기본 지침");
  });
});
