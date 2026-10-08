import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v3 task card compact contract", () => {
  it("keeps folder cards at the shared small row's natural height", () => {
    const folderCard = readFileSync(new URL("./PlannerFolderCard.tsx", import.meta.url), "utf8");
    const frame = readFileSync(new URL("./RunRowFrame.tsx", import.meta.url), "utf8");
    const rowStyles = readFileSync(new URL("./v3-run-history.css", import.meta.url), "utf8");
    const plannerStyles = readFileSync(new URL("./v3-planner-surfaces.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const smallRule = rowStyles.match(/\.v3-run-row--small\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const openRule = rowStyles.match(/\.v3-run-open\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const folderHeightOverrides = Array.from(plannerStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(([, selectors, body]) =>
      selectors.split(",").some(part => /\.v3-task-card\b/.test(part))
      && /(?:^|;)\s*(?:(?:min|max)-)?height\s*:/.test(body),
    );

    expect(folderCard).toContain('<RunRowFrame size="small" variant="folder"');
    expect(folderCard).toContain('const showAssignee = task.assignee !== "담당 미지정" && task.assignee !== "담당 미확인";');
    expect(folderCard).toContain("agentLine={showAssignee ? <span>{task.assignee}</span> : null}");
    expect(frame).toContain('import "./v3-run-history.css";');
    expect(frame).toContain('size==="small"?" v3-run-row--small":""');
    expect(frame).toContain('variant==="folder"?" v3-task-card":""');
    expect(smallRule).toMatch(/min-height:\s*0/);
    expect(openRule).toMatch(/padding:\s*var\(--v3-space-3\)\s+var\(--v3-space-4\)/);
    expect(folderHeightOverrides).toEqual([]);
  });
});
