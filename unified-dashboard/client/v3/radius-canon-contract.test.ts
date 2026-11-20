import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 카드 #1735 항목 6: 곡률은 뿌리 하나(24)에서 나온다. 옛 이름이 다시 들어오지 않게 저장소 시험으로 막는다.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = ["packages/soul-ui/src", "unified-dashboard/client", "soul-desktop/src"];
const EXT = new Set([".ts", ".tsx", ".css"]);
const SKIP_DIR = new Set(["node_modules", "dist", ".turbo", "coverage"]);

const OLD_VAR = new RegExp(
  `--radius-(?:${["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"].join("|")})(?![\\w-])`,
  "g",
);
const OLD_CLASS = new RegExp(
  `(?<![\\w-])rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?(?:-(?:${[
    "xs",
    "sm",
    "md",
    "lg",
    "xl",
    "2xl",
    "3xl",
    "4xl",
  ].join("|")}))?(?![\\w\\-[(])`,
  "g",
);

const isTest = (rel: string) => /(?:__tests__|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$)/.test(rel);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(path);
  }
}

const files: string[] = [];
for (const dir of DIRS) walk(`${ROOT}${dir}`, files);

function offenses(pattern: RegExp, includeTests: boolean): string[] {
  const found: string[] = [];
  for (const file of files) {
    const rel = file.slice(ROOT.length);
    if (!includeTests && isTest(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      const text = line.trim();
      if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
      for (const match of line.matchAll(pattern)) found.push(`${rel}:${index + 1} ${match[0]}`);
    });
  }
  return found;
}

describe("Apple-style radius canon", () => {
  it("keeps one root and no old radius variables anywhere, tests included", () => {
    expect(offenses(OLD_VAR, true)).toEqual([]);
  });

  it("keeps old radius classes out of non-test sources", () => {
    const found = offenses(OLD_CLASS, false).filter((hit) => {
      // ProfileAvatar의 모양 값 shape: 'rounded'는 클래스가 아니다.
      const [where] = hit.split(" ");
      const [, lineNo] = where.split(":");
      const line = readFileSync(`${ROOT}${where.slice(0, where.lastIndexOf(":"))}`, "utf8").split("\n")[
        Number(lineNo) - 1
      ];
      return !(/\bshape\b/.test(line) && /['"]rounded['"]/.test(line));
    });
    expect(found).toEqual([]);
  });

  it("defines root, floor, mark, pill and the concentric utility in globals.css", () => {
    const globals = readFileSync(`${ROOT}packages/soul-ui/src/styles/globals.css`, "utf8").replace(/\s+/g, "");
    expect(globals).toContain("--radius-*:initial");
    expect(globals).toContain("--radius-root:24px");
    expect(globals).toContain("--radius-floor:calc(var(--radius-root)/2)");
    expect(globals).toContain("--radius-mark:calc(var(--radius-root)/6)");
    expect(globals).toContain("--radius-pill:9999px");
    expect(globals).toContain("@utilityrounded-in-*");
  });

  it("gives chat bubbles one radius on all four corners", () => {
    const bubbles = [
      "packages/soul-ui/src/components/chat/AssistantMessage.tsx",
      "packages/soul-ui/src/components/chat/ChatThinkingIndicator.tsx",
      "packages/soul-ui/src/components/chat/UserMessage.tsx",
    ].map((rel) => readFileSync(`${ROOT}${rel}`, "utf8"));
    for (const source of bubbles) {
      expect(source).not.toMatch(/rounded-(?:tl|tr|bl|br|ss|se|es|ee)-[\w[\]()-]+/);
    }
  });
});
