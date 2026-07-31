import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = new URL("./", import.meta.url);
const read = (name: string) =>
  readFileSync(new URL(name, SOURCE_DIRECTORY), "utf8");

describe("agent/node/model assignment mount inventory", () => {
  it("enumerates every direct AgentNodeAssignmentFields mount", () => {
    const mounts = readdirSync(SOURCE_DIRECTORY)
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
      .filter((name) => read(name).includes("<AgentNodeAssignmentFields"))
      .sort();

    expect(mounts).toEqual([
      "NewTaskForm.tsx",
      "ProjectContextFormFields.tsx",
      "SessionSuccessionModal.tsx",
      "TaskDefaultAssignment.tsx",
    ]);
  });

  it("applies the compact row only to the two requested task surfaces", () => {
    expect(read("NewTaskForm.tsx")).toContain('layout="compact-row"');
    expect(read("TaskDefaultAssignment.tsx")).toContain('layout="compact-row"');
    expect(read("SessionSuccessionModal.tsx")).not.toContain('layout="compact-row"');
    expect(read("ProjectContextFormFields.tsx")).not.toContain('layout="compact-row"');
  });

  it("keeps a three-column desktop contract and a one-column narrow contract", () => {
    const css = read("v3-context-succession.css");

    expect(css).toContain(".v3-succession-assignment--compact-row");
    expect(css).toMatch(
      /\.v3-succession-assignment--compact-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0\.8fr\)\s+minmax\(0,\s*0\.9fr\)\s+minmax\(0,\s*1\.35fr\)/s,
    );
    expect(css).toMatch(
      /@media \(max-width:\s*600px\)[\s\S]*?\.v3-succession-assignment\s*\{\s*grid-template-columns:\s*1fr;/,
    );
  });
});
