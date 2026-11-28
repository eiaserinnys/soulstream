import { memo, useSyncExternalStore, type ComponentType } from "react";
import type { Components, MarkdownProps } from "@pierre/words/react";
import { cn } from "../../lib/cn";
import {
  markdownBlockAttribute,
  markdownBlockquoteCopyClass,
  markdownBlockquoteFrameClass,
  markdownBodyClass,
  markdownCheckboxClass,
  markdownCodeBlockClass,
  markdownDeletedClass,
  markdownEmphasisClass,
  markdownH1Class,
  markdownH2Class,
  markdownH3Class,
  markdownH4Class,
  markdownInlineCodeClass,
  markdownListItemClass,
  markdownManuscriptBodyClass,
  markdownOrderedListClass,
  markdownParagraphClass,
  markdownPlainBodyClass,
  markdownRuleClass,
  markdownStreamingCursorClass,
  markdownStreamingFallbackBodyClass,
  markdownStreamingFallbackManuscriptTextClass,
  markdownStreamingFallbackTextClass,
  markdownStrongClass,
  markdownTableClass,
  markdownTableCellClass,
  markdownTableFocusClass,
  markdownTableHeaderCellClass,
  markdownTableWrapperClass,
  markdownTaskListItemClass,
  markdownUnorderedListClass,
  defaultAnchorClass,
} from "../markdown-classes";
import { applyStreamingHardBreaks } from "./streaming-markdown-breaks";

type WordsMarkdownComponent = ComponentType<MarkdownProps>;

let wordsMarkdown: WordsMarkdownComponent | null = null;
let loadPromise: Promise<WordsMarkdownComponent | null> | null = null;
const listeners = new Set<() => void>();

/** words 모듈을 미리 받아 둔다. 채팅 모듈이 올라올 때 한 번 부르면 된다. */
export function preloadStreamingMarkdown(): Promise<WordsMarkdownComponent | null> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = import("@pierre/words/react")
    .then((module) => {
      wordsMarkdown = module.Markdown as WordsMarkdownComponent;
      for (const listener of [...listeners]) listener();
      return wordsMarkdown;
    })
    .catch((error: unknown) => {
      // 스트리밍은 평문으로 이어 간다. 다음 장착에서 다시 시도할 수 있게 약속을 비운다.
      loadPromise = null;
      console.warn("스트리밍 마크다운 모듈을 불러오지 못해 평문으로 보여줍니다.", error); // i18n-ignore: 개발자 콘솔 경고
      return null;
    });
  return loadPromise;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WordsMarkdownComponent | null {
  return wordsMarkdown;
}

// SSR에도 같은 값을 준다. 브라우저 첫 렌더에서 이미 받아 두었으면 바로 마크다운으로 그린다.
function getServerSnapshot(): WordsMarkdownComponent | null {
  return wordsMarkdown;
}

function addAttributes(html: string, attributes: string): string {
  return html.replace(/^<([a-z][a-z0-9-]*)/, `<$1 ${attributes}`);
}

function block(html: string, className?: string): string {
  const attributes = className === undefined
    ? markdownBlockAttribute
    : `class="${className}" ${markdownBlockAttribute}`;
  return addAttributes(html, attributes);
}

// 완료 렌더(markdown-components.tsx의 기본 components, compact 아님, bounded, linkTone default)와
// 같은 클래스를 words의 HTML 문자열 훅으로 주입한다. words는 React 자식을 받지 않는다.
const streamingComponents: Components = {
  p: (html) => block(html, markdownParagraphClass),
  h1: (html) => block(html, markdownH1Class),
  h2: (html) => block(html, markdownH2Class),
  h3: (html) => block(html, markdownH3Class),
  h4: (html) => block(html, markdownH4Class),
  h5: (html) => block(html),
  h6: (html) => block(html),
  ul: (html) => block(html, markdownUnorderedListClass),
  ol: (html) => block(html, markdownOrderedListClass),
  li: (html) => addAttributes(html, `class="${html.includes("<input ") ? markdownTaskListItemClass : markdownListItemClass}"`),
  input: (html) => addAttributes(html, `class="${markdownCheckboxClass}"`),
  pre: (html) => {
    // words의 코드 블록 틀(머리줄 없는 pre)을 완료 렌더의 pre 클래스로 다시 세운다.
    const body = html.replace(/^<pre[^>]*>/, "").replace(/<\/pre>$/, "");
    return `<pre class="${markdownCodeBlockClass}" data-slot="codeblock-copy-content">${body}</pre>`;
  },
  inlineCode: (html) => addAttributes(html, `class="${markdownInlineCodeClass}"`),
  strong: (html) => addAttributes(html, `class="${markdownStrongClass}"`),
  em: (html) => addAttributes(html, `class="${markdownEmphasisClass}"`),
  del: (html) => addAttributes(html, `class="${markdownDeletedClass}"`),
  a: (html) => addAttributes(html, `class="${defaultAnchorClass}" target="_blank" rel="noopener noreferrer"`),
  // 스트리밍 중에는 이미지를 그리지 않는다. 완료되면 MarkdownContent가 지금처럼 그린다.
  img: () => "",
  hr: (html) => block(html, markdownRuleClass),
  blockquote: (html) => {
    // 완료 렌더의 인용문과 같은 틀(상대 상자, 복사 단추 자리 pr-9, 똑같은 클래스)로 그린다.
    const quote = addAttributes(
      html,
      `data-slot="blockquote-copy-content" data-markdown-blockquote="true" class="${markdownBlockquoteCopyClass}"`,
    );
    return `<div class="${markdownBlockquoteFrameClass}" ${markdownBlockAttribute}>${quote}</div>`;
  },
  table: (html) => {
    const table = addAttributes(html, `class="${markdownTableClass}"`);
    return `<div class="${markdownTableWrapperClass} ${markdownTableFocusClass}" ${markdownBlockAttribute}>${table}</div>`;
  },
  th: (html) => addAttributes(html, `class="${markdownTableHeaderCellClass}"`),
  td: (html) => addAttributes(html, `class="${markdownTableCellClass}"`),
};

export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  manuscript = false,
}: {
  content: string;
  manuscript?: boolean;
}) {
  const WordsMarkdown = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (WordsMarkdown === null) {
    // words 모듈을 받기 전에 스트리밍이 오면 그 사이만 지금 평문을 쓴다.
    return (
      <div
        data-slot="chat-body"
        className={cn(
          markdownStreamingFallbackBodyClass,
          manuscript ? markdownStreamingFallbackManuscriptTextClass : markdownStreamingFallbackTextClass,
        )}
      >
        {content}
        <span className={markdownStreamingCursorClass} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      data-slot="chat-body"
      className={cn(markdownBodyClass, manuscript ? markdownManuscriptBodyClass : markdownPlainBodyClass)}
    >
      <WordsMarkdown
        mode="streaming"
        isAnimating
        controls={false}
        lineNumbers={false}
        caret="block"
        components={streamingComponents}
      >
        {applyStreamingHardBreaks(content)}
      </WordsMarkdown>
    </div>
  );
});
