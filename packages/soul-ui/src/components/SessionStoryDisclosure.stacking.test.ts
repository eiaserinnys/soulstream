import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

function expectV3HeaderLift(): void {
  const stylesheet = readSource("../../../../unified-dashboard/client/v3/v3-task-workspace.css");
  expect(stylesheet).toMatch(
    /\.v3-chat-pane\s*>\s*\.v3-chat-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/s,
  );
}

function chatHeaders(source: string): string[] {
  return source.match(/<header className="v3-chat-header"[\s\S]*?<\/header>/g) ?? [];
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
      "packages/soul-ui/src/components/MobileChatHeader.tsx",
      "packages/soul-ui/src/components/chat/ChatView.tsx",
      "unified-dashboard/client/v3/TaskBoardWorkspace.tsx",
      "unified-dashboard/client/v3/TaskWorkspace.tsx",
      "unified-dashboard/client/v3/TaskWorkspace.tsx",
    ]);
  });

  it("keeps the desktop chat header stacking context above the message list", () => {
    const source = readSource("./chat/ChatView.tsx");

    expect(source).toContain(
      'className="relative z-[1] mb-3 flex h-[50px]',
    );
  });

  it("keeps the mobile chat header stacking context above the message list", () => {
    const source = readSource("./MobileChatHeader.tsx");

    expect(source).toContain(
      'className="relative z-[1] shrink-0 px-3 py-2"',
    );
  });

  it("lifts the standalone TaskWorkspace chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/TaskWorkspace.tsx");
    const header = chatHeaders(source).find((candidate) => candidate.includes('label="채팅 닫기"'));

    expect(header).toContain("<SessionStoryDisclosure");
    expectV3HeaderLift();
  });

  it("lifts the task inspector chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/TaskWorkspace.tsx");
    const header = chatHeaders(source).find((candidate) => !candidate.includes('label="채팅 닫기"'));

    expect(header).toContain("<SessionStoryDisclosure");
    expectV3HeaderLift();
  });

  it("lifts the TaskBoardWorkspace chat header above its review banner and message list", () => {
    const source = readSource("../../../../unified-dashboard/client/v3/TaskBoardWorkspace.tsx");
    const header = chatHeaders(source).find((candidate) => candidate.includes("<SessionStoryDisclosure"));

    expect(header).toContain("<SessionStoryDisclosure");
    expectV3HeaderLift();
  });
});
