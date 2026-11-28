import { useEffect, useRef, useState } from 'react';
import type { Node } from '@soulstream/chat-ui';
import { ChatImageAttachments, ChatImageViewer } from '../chat/ChatImageAttachments';
import { attachmentContentUrl } from '../../lib/chat-attachment-model';

type ImageNode = Extract<Node, { kind: 'image' }>;
type HtmlNode = Extract<Node, { kind: 'html' }>;
export function ChatUiImage({ node, sessionId, imageUrl }: { node: ImageNode; sessionId?: string; imageUrl?: string }) {
  const [index, setIndex] = useState<number | null>(null); const [metadata, setMetadata] = useState({});
  if (!sessionId && !imageUrl) return <p>{node.alt}</p>;
  const src = imageUrl ?? attachmentContentUrl(node.attachment_id, { type: 'session', id: sessionId! });
  const gallery = [{ id: node.attachment_id, src, alt: node.alt }];
  return <figure className="chat-ui-image"><ChatImageAttachments gallery={gallery} galleryIndexes={[0]} role="assistant" runId={node.id} metadataByImage={metadata} onMetadata={(key, value) => setMetadata(previous => ({ ...previous, [key]: value }))} onOpen={position => setIndex(position)} hideFilename /><ChatImageViewer gallery={gallery} index={index ?? -1} metadataByImage={metadata} onOpenChange={open => { if (!open) setIndex(null); }} onIndexChange={setIndex} />{node.caption && <figcaption className="chat-ui-display-meta">{node.caption}</figcaption>}</figure>;
}
export function ChatUiHtml({ node }: { node: HtmlNode }) {
  const ref = useRef<HTMLDivElement>(null); const [styles, setStyles] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const update = () => {
      if (!ref.current) return;
      const computed = getComputedStyle(ref.current);
      const scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      setStyles(`color-scheme:${scheme};--host-fg:${computed.color};--host-fg-2:${computed.getPropertyValue('--v3-text-secondary')};--host-accent:${computed.getPropertyValue('--info')};--host-font:${computed.fontFamily};`);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);
  const srcDoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>:root{${styles}}body{color:var(--host-fg);font-family:var(--host-font);background:transparent}</style></head><body>${node.html}</body></html>`;
  return <div ref={ref} className="chat-ui-html">{failed ? <p>{node.alt}</p> : <iframe title={node.alt} sandbox="" srcDoc={srcDoc} style={{ height: node.height }} onError={() => setFailed(true)} />}</div>;
}
