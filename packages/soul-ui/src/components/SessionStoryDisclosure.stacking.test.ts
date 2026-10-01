import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

function expectV3HeaderLift(): void {
  const stylesheet = readSource("../../../../unified-dashboard/client/v3/v3-folder-workspace.css");
  expect(stylesheet).toMatch(
    /\.v3-chat-pane\s*>\s*\.v3-chat-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s,
  );
}

function chatHeaders(source: string): string[] {
  return source.match(/<header className="[^"]*\bv3-chat-header\b[^"]*"[\s\S]*?<\/header>/g) ?? [];
}

function expectSharedStoryHeader(): void {
  const source = readSource("../../../../unified-dashboard/client/v3/WorkspacePanelHeaders.tsx");
  expect(chatHeaders(source)[0]).toContain("<SessionStoryDisclosure");
  expectV3HeaderLift();
}

function sessionStoryMounts(): string[] {
  const repositoryRoot = new URL("../../../../", import.meta.url);
  const searchRoots = [
    new URL("packages/soul-ui/src/", repositoryRoot),
    new URL("unified-dashboard/client/", repositoryRoot),
  ];
  const mounts: string[] = [];

  const visit = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryUrl = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        visit(new URL(`${entry.name}/`, directory));
      } else if (
        entry.name.endsWith(".tsx")
        && !entry.name.endsWith(".test.tsx")
        && !entry.name.endsWith(".spec.tsx")
      ) {
        const source = readFileSync(entryUrl, "utf-8");
        const count = source.match(/<SessionStoryDisclosure\b/g)?.length ?? 0;
        const relativePath = relative(
          fileURLToPath(repositoryRoot),
          fileURLToPath(entryUrl),
        ).replaceAll("\\", "/");
        for (let index = 0; index < count; index += 1) {
          mounts.push(relativePath);
        }
      }
    }
  };

  for (const searchRoot of searchRoots) visit(searchRoot);
  return mounts.sort();
}

describe("SessionStoryDisclosure stacking contract", () => {
  it("enumerates every production mount surface", () => {
    expect(sessionStoryMounts()).toEqual([
      "unified-dashboard/client/v3/WorkspacePanelHeaders.tsx",
    ]);
  });

  it("lifts the standalone FolderWorkspace chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/FolderWorkspace.tsx");
    const header = source.match(/<SessionPanelHeader[\s\S]*?\/>/g)?.find(candidate => candidate.includes("onClose="));

    expect(header).toContain("<SessionPanelHeader");
    expectSharedStoryHeader();
  });

  it("lifts the task inspector chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/FolderWorkspace.tsx");
    const header = source.match(/<SessionPanelHeader[\s\S]*?\/>/g)?.find(candidate => !candidate.includes("onClose="));

    expect(header).toContain("<SessionPanelHeader");
    expectSharedStoryHeader();
  });

  it("lifts the shared folder/card chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/WorkspaceSessionColumn.tsx");
    for (const surface of ["FolderBoardWorkspace", "CardWorkspace"]) {
      expect(readSource(`../../../../unified-dashboard/client/v3/${surface}.tsx`)).toContain("<WorkspaceSessionColumn");
    }
    expect(readSource("../../../../unified-dashboard/client/v3/V3DashboardLayout.tsx")).toContain("<CardWorkspace");
    const header = source.match(/<SessionPanelHeader[\s\S]*?\/>/)?.[0];

    expect(header).toContain("<SessionPanelHeader");
    expectSharedStoryHeader();
  });
});
