/**
 * MarkdownContent - 채팅 메시지용 마크다운 렌더링
 *
 * 기존 채팅 스타일(text-[15px], text-foreground)을 유지하면서
 * 마크다운 구조(코드블록, 링크, 리스트 등)만 렌더링합니다.
 * @tailwindcss/typography (prose)를 사용하지 않고 커스텀 컴포넌트로 스타일링합니다.
 */

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface MarkdownContentProps {
  content: string;
}

const components: Components = {
  // 블록 요소
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="text-[17px] font-bold mb-2 mt-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[16px] font-bold mb-2 mt-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[15px] font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[15px] font-semibold mb-1 mt-2 first:mt-0">{children}</h4>
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
    <pre className="text-[12px] text-muted-foreground bg-input rounded px-2 py-1.5 my-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono">
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
        className="text-[13px] bg-input rounded px-1 py-0.5 font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },

  // 인라인 요소
  a: ({ children, ...props }) => (
    <a
      className="text-accent-blue hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
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
  table: ({ children }) => (
    <div className="overflow-auto my-2">
      <table className="text-[13px] border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold bg-input">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
