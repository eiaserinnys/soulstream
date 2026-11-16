/**
 * 카드 #1461: 마크다운 표 스크롤 상자의 키보드 초점 고리.
 *
 * 넘치는 표의 래퍼는 키보드 Tab으로 들어가는데, 래퍼에 초점 규칙이 없으면
 * 브라우저 기본 흰 둥근 외곽선이 그려진다. fullsize와 compact 두 래퍼가
 * soul-ui 스크롤 상자(ui/scroll-area.tsx)와 같은 공용 초점 클래스를 쓰는지
 * 확인하고, 초점 클래스 밖의 모양 클래스가 바뀌지 않았는지 함께 고정한다.
 *
 * @vitest-environment jsdom
 */

import { createElement, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownContent } from "./MarkdownContent";

const FOCUS_CLASSES = [
  "outline-none",
  "focus-visible:ring-2",
  "focus-visible:ring-ring",
  "focus-visible:ring-offset-1",
  "focus-visible:ring-offset-background",
];

const longHash = "8c05d01e24f96b70a612750a4f45795bacdab636";
const tableMarkdown = [
  "| 항목 | 상태 | 해시 |",
  "| --- | --- | --- |",
  `| 줄바꿈을 확인합니다 | 확인합니다 | \`${longHash}\` |`,
  `| 표 넘침을 확인합니다 | 확인합니다 | ${longHash} |`,
].join("\n");

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function unmount() {
  if (root) flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

afterEach(unmount);

function renderMarkdown(content: string, props: Partial<Parameters<typeof MarkdownContent>[0]> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(MarkdownContent, { content, ...props }) as ReactElement));
  return container;
}

function tableWrapper(host: HTMLElement): HTMLDivElement {
  const table = host.querySelector("table");
  expect(table).not.toBeNull();
  const wrapper = table!.parentElement;
  expect(wrapper).toBeInstanceOf(HTMLDivElement);
  return wrapper as HTMLDivElement;
}

describe("MarkdownContent — table scroll focus ring", () => {
  it.each([
    ["fullsize", {}, "my-2"],
    ["compact", { compact: true }, "my-1"],
  ] as const)("gives the %s table wrapper the shared scroll focus classes", (_label, props, marginClass) => {
    const wrapper = tableWrapper(renderMarkdown(tableMarkdown, props));

    for (const focusClass of FOCUS_CLASSES) {
      expect(wrapper.classList.contains(focusClass)).toBe(true);
    }

    // 초점 클래스 밖의 모양 클래스는 그대로다.
    for (const shapeClass of ["overflow-auto", "rounded", "border", "border-border", "bg-card", marginClass]) {
      expect(wrapper.classList.contains(shapeClass)).toBe(true);
    }

    // 카드 지침: 표 래퍼에 tabindex를 더하거나 빼지 않는다.
    expect(wrapper.hasAttribute("tabindex")).toBe(false);
  });

  it("keeps the same focus class string on both wrappers", () => {
    const fullsizeClasses = tableWrapper(renderMarkdown(tableMarkdown)).className.split(/\s+/);
    unmount();
    const compactClasses = tableWrapper(renderMarkdown(tableMarkdown, { compact: true })).className.split(/\s+/);
    expect(compactClasses.filter((name) => FOCUS_CLASSES.includes(name)).sort())
      .toEqual(fullsizeClasses.filter((name) => FOCUS_CLASSES.includes(name)).sort());
  });
});
