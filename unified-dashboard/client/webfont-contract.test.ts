import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("loads the bundled variable webfont through the shared web entry", () => {
  const css = read("./globals.css");
  expect(read("./main.tsx")).toContain('import "./globals.css";');
  expect(css).toMatch(/@font-face\s*\{[^}]*font-family:\s*"Pretendard Variable"/s);
  expect(css).toContain('url("/fonts/pretendard/1.3.9/PretendardVariable.woff2") format("woff2")');
  expect(css).toContain("font-weight: 100 900;");
  expect(css).toContain("font-style: normal;");
  expect(css).toContain("font-display: swap;");
  const font = readFileSync(new URL("../public/fonts/pretendard/1.3.9/PretendardVariable.woff2", import.meta.url));
  expect(font.subarray(0, 4).toString()).toBe("wOF2");
  expect(read("../public/fonts/pretendard/1.3.9/OFL.txt")).toContain("SIL OPEN FONT LICENSE Version 1.1");
});
