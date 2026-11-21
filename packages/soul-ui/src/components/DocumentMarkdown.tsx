import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { components, createCopyableCodeBlock } from "./markdown-components";

const documentComponents = { ...components, pre: createCopyableCodeBlock(false, "document") };

export function DocumentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeHighlight]} components={documentComponents}>
      {content}
    </ReactMarkdown>
  );
}
