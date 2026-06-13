/**
 * MarkdownContent plugin 단위 테스트
 *
 * react-markdown + remark-gfm + remark-breaks 조합이 단일 \n을 hard break(<br>)로
 * 변환하고, fenced code 내부와 \n\n paragraph 경계는 유지함을 검증한다.
 *
 * 환경: Node + vitest. jsdom 없이 react-dom/server.renderToStaticMarkup으로
 * 정적 HTML을 받아 검증.
 */

import { describe, test, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { MarkdownContent } from "./MarkdownContent";

const render = (markdown: string): string =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm, remarkBreaks] },
      markdown,
    ),
  );

const renderMarkdownContent = (
  markdown: string,
  props: Partial<Parameters<typeof MarkdownContent>[0]> = {},
): string =>
  renderToStaticMarkup(createElement(MarkdownContent, { content: markdown, ...props }));

describe("MarkdownContent — remark-breaks plugin", () => {
  test("case 1: single \\n is rendered as <br>", () => {
    const html = render("a\nb");
    expect(html).toMatch(/<br\s*\/?>/);
    expect(html).toContain("a");
    expect(html).toContain("b");
  });

  test("case 2: \\n\\n produces two paragraphs (no <br> at boundary)", () => {
    const html = render("a\n\nb");
    // 두 개의 <p> 태그가 있어야 한다
    const pCount = (html.match(/<p>/g) ?? []).length;
    expect(pCount).toBe(2);
  });

  test("case 3: fenced code interior preserves \\n without <br>", () => {
    const html = render("```\nlet x = 1\nlet y = 2\n```");
    // <code> 또는 <pre> 안에는 <br>이 없어야 한다
    const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1]).not.toMatch(/<br\s*\/?>/);
  });

  test("case 4: empty string renders without error", () => {
    expect(() => render("")).not.toThrow();
  });

  test("case 5: default links keep the existing accent-blue tone", () => {
    const html = renderMarkdownContent("[docs](https://example.com)");

    expect(html).toContain("text-accent-blue hover:underline");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("case 6: user bubble links use white underlined text", () => {
    const html = renderMarkdownContent("[docs](https://example.com)", {
      linkTone: "onUserBubble",
    });

    expect(html).toContain("text-white underline decoration-white/70 underline-offset-2");
    expect(html).not.toContain("text-accent-blue hover:underline");
  });
});
