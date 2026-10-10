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
import { readFileSync } from "node:fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownImage } from "./MarkdownImage";

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
  test("mixed checklist text and inline code stay in one inline flow", () => {
    const html = renderMarkdownContent('- [ ] 폴더 `folders.checklist_enabled` 제거 후 **기존 상태**를 유지합니다.\n- [x] `create_card` 요청 확인');
    const items = [...html.matchAll(/<li\b[^>]*>/g)].map(match => match[0]);
    expect(items).toHaveLength(2);
    // Flex/grid would split ReactMarkdown's text, code and emphasis nodes into
    // separate columns. This renderer's public markup must retain inline flow.
    for (const item of items) expect(item).not.toMatch(/\b(?:flex|grid)\b/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('checked=""');
    expect(html).toContain('folders.checklist_enabled</code> 제거 후 <strong');
  });
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

  test("case 7: document fenced code expands vertically with separate horizontal overflow", () => {
    const html = renderMarkdownContent("```yaml\ndialogue: one\ndialogue: two\n```", {
      codeBlockLayout: "document",
    });

    expect(html).toContain('data-markdown-code-scroll="horizontal"');
    expect(html).toContain("overflow-x-auto overflow-y-hidden");
    expect(html).toContain('data-markdown-code-layout="document"');
    expect(html).not.toContain("max-h-60");
  });

  test("case 8: chat and compact feeds retain bounded code blocks", () => {
    const chat = renderMarkdownContent("```text\nchat\n```");
    const compact = renderMarkdownContent("```text\nfeed\n```", { compact: true });

    expect(chat).toContain("overflow-auto max-h-60");
    expect(compact).toContain("overflow-auto max-h-24");
    expect(chat).not.toContain('data-markdown-code-layout="document"');
    expect(compact).not.toContain('data-markdown-code-layout="document"');
  });

  test("manuscript maps only root standalone direct image rows into message runs", () => {
    const markdown = [
      "앞 설명",
      "![첫 이미지](/api/attachments/files?path=%2Ffirst.png)",
      "![둘째 이미지](//images.test/second.png)",
      "중간 설명",
      "![셋째 이미지](/third.png)",
      "![참조 이미지][ref]",
      "[ref]: /reference.png",
      "> ![인용 이미지](/quoted.png)",
      "```markdown",
      "![펜스 예시](/fenced.png)",
      "```",
    ].join("\n\n");
    const chatImages = { role: "assistant" };
    const html = renderMarkdownContent(markdown, {
      chatImages,
    } as unknown as Partial<Parameters<typeof MarkdownContent>[0]>);

    expect(html.match(/data-chat-image-run=/g)).toHaveLength(2);
    expect(html).toContain('data-chat-image-count="2"');
    expect(html).toContain('data-chat-image-count="1"');
    expect(html).toContain('src="//images.test/second.png"');
    expect(html).toContain("중간 설명");
    expect(html).toContain('src="/reference.png"');
    expect(html).toContain('src="/quoted.png"');
    expect(html).not.toContain('src="/fenced.png"');
  });

  test("default markdown image keeps its existing noninteractive renderer", () => {
    const html = renderMarkdownContent("![이미지](/image.png)");

    expect(html).toContain('src="/image.png"');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("data-chat-image-run=");
  });

  test("card evidence keeps its existing registered image variant", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImage, {
      src: "/evidence.png",
      alt: "증거",
      variant: "card-evidence",
    }));

    expect(html).toContain("v3-card-evidence-image");
    expect(html).not.toContain("chat-image-refined");
  });

  test("chat thumbnails use a bounded square frame, contain the source, and align user captions", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImage, {
      src: "/thumbnail.png",
      alt: "대화 이미지",
      variant: "chatRefined",
      className: "chat-image-thumbnail-image",
      frameClassName: "chat-image-thumbnail-frame",
    }));
    const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

    expect(html).toContain('class="chat-image-frame chat-image-thumbnail-frame"');
    expect(css).toMatch(/--chat-attachment-thumbnail-max-size:\s*200px;/);
    expect(css).toMatch(/\.chat-image-card\s*\{[^}]*width:\s*min\(100%,\s*var\(--chat-attachment-thumbnail-max-size\)\)[^}]*\}/s);
    expect(css).toMatch(/\.chat-image-thumbnail-frame\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1\s*\/\s*1[^}]*\}/s);
    expect(css).toMatch(/\.chat-image-refined\.chat-image-thumbnail-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain[^}]*\}/s);
    expect(css).toMatch(/\.chat-image-run\[data-chat-image-role="user"\]\s+\.chat-image-caption\s*\{[^}]*text-align:\s*right[^}]*\}/s);
  });
});
