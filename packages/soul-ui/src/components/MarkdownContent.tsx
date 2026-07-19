/**
 * MarkdownContent - 채팅 메시지용 마크다운 렌더링
 *
 * 기존 채팅 스타일(text-base, text-foreground)을 유지하면서
 * 마크다운 구조(코드블록, 링크, 리스트 등)만 렌더링합니다.
 * @tailwindcss/typography (prose)를 사용하지 않고 커스텀 컴포넌트로 스타일링합니다.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  linkTone?: "default" | "onUserBubble";
  enableBlockquoteCopy?: boolean;
}

const defaultAnchorClass = "text-accent-blue hover:underline";
const userBubbleAnchorClass =
  "text-white underline decoration-white/70 underline-offset-2 hover:decoration-white";

const createAnchorComponent = (className: string): NonNullable<Components["a"]> =>
  ({ children, ...props }) => (
    <a
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  );

const defaultAnchor = createAnchorComponent(defaultAnchorClass);
const userBubbleAnchor = createAnchorComponent(userBubbleAnchorClass);

const components: Components = {
  // 블록 요소
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-base font-semibold mb-1 mt-2 first:mt-0">{children}</h4>
  ),

  // 리스트
  ul: ({ children }) => <ul className="mb-2 last:mb-0 ml-4 list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 last:mb-0 ml-4 list-decimal">{children}</ol>,
  li: ({ children, className }) => {
    // GFM 태스크 리스트: remark-gfm이 className="task-list-item"을 추가
    if (className === "task-list-item") {
      return (
        <li className="mb-0.5 list-none -ml-4 flex items-start gap-1.5">
          {children}
        </li>
      );
    }
    return <li className="mb-0.5">{children}</li>;
  },
  // GFM 태스크 리스트 체크박스
  input: ({ type, checked, ...props }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className="mt-1 accent-accent-blue pointer-events-none"
          {...props}
        />
      );
    }
    return <input type={type} checked={checked} {...props} />;
  },

  // 코드 — 기존 CollapsibleContent/ToolCallItem의 <pre> 스타일과 통일
  pre: ({ children }) => (
    <pre className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 my-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    // rehype-highlight가 language-* 클래스를 추가한 경우 → 코드블록 내부
    const isBlock = className?.startsWith("language-") || className?.startsWith("hljs");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    // 인라인 코드
    return (
      <code
        className="text-xs bg-input rounded px-1 py-0.5 font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },

  // 인라인 요소
  a: defaultAnchor,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => (
    <del className="text-muted-foreground line-through">{children}</del>
  ),

  // 이미지
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ""}
      className="max-w-full rounded my-1.5"
      loading="lazy"
    />
  ),

  // 구분선
  hr: () => <hr className="border-border my-3" />,

  // 인용
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
      {children}
    </blockquote>
  ),

  // 테이블
  // 다크모드 가독성: 컨테이너 bg-card(거의 검정) + 보더, 헤더 bg-input(8% white)로 강조,
  // td/th에 text-foreground 명시하여 부모 컨텍스트 무관하게 다크/라이트 모두 또렷.
  table: ({ children }) => (
    <div className="overflow-auto my-2 rounded border border-border bg-card">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold bg-input text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1 text-foreground">{children}</td>
  ),
};

// 피드 카드 등 컴팩트 레이아웃용 컴포넌트 맵 (모듈 레벨 상수, 렌더링마다 새 객체 생성 방지)
const compactComponents: Components = {
  p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="text-sm font-semibold mb-1 mt-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold mb-1 mt-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mb-0.5 mt-1 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium mb-0.5 mt-1 first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="mb-1 last:mb-0 ml-3 list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1 last:mb-0 ml-3 list-decimal">{children}</ol>,
  li: ({ children }) => <li className="mb-0">{children}</li>,
  pre: ({ children }) => (
    <pre className="text-xs text-muted-foreground bg-input rounded px-1.5 py-1 my-1 whitespace-pre-wrap break-words overflow-auto max-h-24 font-mono">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.startsWith("language-") || className?.startsWith("hljs");
    if (isBlock) {
      return <code className={className} {...props}>{children}</code>;
    }
    return (
      <code className="text-xs bg-input rounded px-0.5 py-0 font-mono" {...props}>
        {children}
      </code>
    );
  },
  a: defaultAnchor,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-2 my-1 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  // 테이블 (compact): 다크모드 토큰을 fullsize와 동일하게 적용 + 패딩만 컴팩트.
  // 누락 시 ReactMarkdown 기본 HTML 렌더 → 다크모드에서 흰 배경 노출.
  table: ({ children }) => (
    <div className="overflow-auto my-1 rounded border border-border bg-card">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-1.5 py-0.5 text-left font-semibold bg-input text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-1.5 py-0.5 text-foreground">{children}</td>
  ),
};

const userBubbleComponents: Components = { ...components, a: userBubbleAnchor };
const compactUserBubbleComponents: Components = { ...compactComponents, a: userBubbleAnchor };

const BlockquoteDepthContext = createContext(0);

function CopyableBlockquote({
  children,
  compact,
}: {
  children: React.ReactNode;
  compact: boolean;
}) {
  const depth = useContext(BlockquoteDepthContext);
  const contentRef = useRef<HTMLQuoteElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");
  const quoteClassName = compact
    ? "border-l-2 border-muted-foreground/30 pl-2 my-1 text-muted-foreground italic"
    : "border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic";

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  if (depth > 0) {
    return (
      <BlockquoteDepthContext.Provider value={depth + 1}>
        <blockquote className={quoteClassName}>{children}</blockquote>
      </BlockquoteDepthContext.Provider>
    );
  }

  const copyQuote = async () => {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await clipboard.writeText(contentRef.current?.innerText.trim() ?? "");
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };

  const feedback = copyState === "success"
    ? "인용문을 복사했습니다"
    : copyState === "error"
      ? "인용문을 복사하지 못했습니다"
      : "";

  return (
    <BlockquoteDepthContext.Provider value={depth + 1}>
      <div className="group/blockquote relative">
        <blockquote
          ref={contentRef}
          data-slot="blockquote-copy-content"
          className={`${quoteClassName} pr-9`}
        >
          {children}
        </blockquote>
        <button
          type="button"
          aria-label="인용문 복사"
          data-copy-state={copyState}
          onClick={() => void copyQuote()}
          className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {copyState === "success"
            ? <Check className="size-4" aria-hidden="true" />
            : <Copy className="size-4" aria-hidden="true" />}
        </button>
        <span className="sr-only" role="status" aria-live="polite">{feedback}</span>
      </div>
    </BlockquoteDepthContext.Provider>
  );
}

function createCopyableBlockquote(compact: boolean): NonNullable<Components["blockquote"]> {
  return ({ children }) => <CopyableBlockquote compact={compact}>{children}</CopyableBlockquote>;
}

export function MarkdownContent({
  content,
  compact = false,
  linkTone = "default",
  enableBlockquoteCopy = false,
}: MarkdownContentProps) {
  const selectedComponents = useMemo(() => {
    const baseComponents = linkTone === "onUserBubble"
      ? compact
        ? compactUserBubbleComponents
        : userBubbleComponents
      : compact
        ? compactComponents
        : components;
    return enableBlockquoteCopy
      ? { ...baseComponents, blockquote: createCopyableBlockquote(compact) }
      : baseComponents;
  }, [compact, enableBlockquoteCopy, linkTone]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeHighlight]}
      components={selectedComponents}
    >
      {content}
    </ReactMarkdown>
  );
}
