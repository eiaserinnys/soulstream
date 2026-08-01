import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = [
  new URL("./", import.meta.url),
  new URL("../../packages/soul-ui/src/components/", import.meta.url),
];

function productTsxFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) return productTsxFiles(url);
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) return [];
    if (entry.name === "ChatView.tsx") return [];
    return [url];
  });
}

function chatViewCallCount(source: string): number {
  return source.match(/<ChatView(?:\s|>)/g)?.length ?? 0;
}

describe("ChatView product mount inventory", () => {
  it("제품 직접 호출 여섯 곳과 TaskWorkspace 내부 두 호출을 exact inventory로 고정한다", () => {
    const actual = productTsxFiles(ROOTS[0])
      .concat(productTsxFiles(ROOTS[1]))
      .map((url) => ({
        path: relative(REPO_ROOT, fileURLToPath(url)).replaceAll("\\", "/"),
        count: chatViewCallCount(readFileSync(url, "utf8")),
      }))
      .filter(({ count }) => count > 0)
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(actual).toEqual([
      { path: "packages/soul-ui/src/components/RightPanel.tsx", count: 1 },
      { path: "unified-dashboard/client/DashboardLayout.tsx", count: 1 },
      { path: "unified-dashboard/client/OrchestratorDashboardLayout.tsx", count: 1 },
      { path: "unified-dashboard/client/v3/TaskBoardWorkspace.tsx", count: 1 },
      { path: "unified-dashboard/client/v3/TaskWorkspace.tsx", count: 2 },
    ]);
    expect(actual.reduce((sum, entry) => sum + entry.count, 0)).toBe(6);
  });
});
