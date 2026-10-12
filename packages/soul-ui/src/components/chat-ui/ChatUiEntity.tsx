import { useId, useState } from 'react';
import { renderParts, type ChatUiState, type Node, type NormalizedChatUiDocumentV1, type Source } from '@soulstream/chat-ui';
import { Button, type ButtonVariant } from '../ui/button';
import { SourceLink } from '../SourceLink';

export function ChatUiSource({ source, label, variant }: { source: Source; label?: string; variant?: ButtonVariant }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (source.type === 'external_link') {
    const anchor = <SourceLink href={source.url} className={variant ? undefined : 'chat-ui-source'}>{label ?? source.label}</SourceLink>;
    return variant ? <Button variant={variant} render={anchor} /> : anchor;
  }
  return <div className="chat-ui-field">
    {source.note ? <Button variant={variant ?? 'link'} className={variant ? undefined : 'chat-ui-source'} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{label ?? source.label}</Button>
      : <span className="chat-ui-meta">{label ?? source.label}</span>}
    {open && <p id={id} className="chat-ui-meta">{source.note}</p>}
  </div>;
}

export function ChatUiEntity({ node, doc, state, variant, showSource }: {
  node: Extract<Node, { kind: 'entity' }>;
  doc: NormalizedChatUiDocumentV1;
  state: ChatUiState;
  variant: ButtonVariant;
  showSource: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="chat-ui-field">
    <Button className="chat-ui-entity" variant={variant} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{node.label}</span><span aria-hidden="true">{open ? '⌄' : '›'}</span>
    </Button>
    {open && <div id={id} className="chat-ui-field"><p>{renderParts(doc, state, node.details)}</p>
      {node.source && showSource && <ChatUiSource source={doc.sources[node.source]} />}
    </div>}
  </div>;
}
