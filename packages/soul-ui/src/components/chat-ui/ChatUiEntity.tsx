import { useId, useState } from 'react';
import { renderParts, type ChatUiState, type Node, type NormalizedChatUiDocumentV1, type Source } from '@soulstream/chat-ui';
import { Button, type ButtonVariant } from '../ui/button';
import { SourceLink } from '../SourceLink';
import { useInternalLinkClick } from '../InternalLinkProvider';

export function ChatUiSource({ source, label, variant, open: controlledOpen, onOpenChange, showNote = true, noteId }: { source: Source; label?: string; variant?: ButtonVariant; open?: boolean; onOpenChange?: (open: boolean) => void; showNote?: boolean; noteId?: string }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const handleInternalLinkClick = useInternalLinkClick();
  const id = useId();
  if (source.type === 'external_link') {
    return variant ? <Button variant={variant} render={<a href={source.url} target="_blank" rel="noopener noreferrer" onClick={handleInternalLinkClick} />}>{label ?? source.label}</Button>
      : <SourceLink href={source.url} className="chat-ui-source">{label ?? source.label}</SourceLink>;
  }
  return <div className="chat-ui-field chat-ui-source-disclosure">
    {source.note ? <Button variant={variant ?? 'link'} className={variant ? undefined : 'chat-ui-source'} aria-expanded={open} aria-controls={noteId ?? id} onClick={() => setOpen(!open)}>{label ?? source.label}</Button>
      : <span className="chat-ui-meta">{label ?? source.label}</span>}
    {open && showNote && <p id={id} className="chat-ui-meta">{source.note}</p>}
  </div>;
}

export function ChatUiEntity({ node, doc, state, variant, showSource, open, onOpenChange }: {
  node: Extract<Node, { kind: 'entity' }>;
  doc: NormalizedChatUiDocumentV1;
  state: ChatUiState;
  variant: ButtonVariant;
  showSource: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  return <div className="chat-ui-field">
    <Button className="chat-ui-entity" variant={variant} aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
      <span>{node.label}</span><span aria-hidden="true">{open ? '⌄' : '›'}</span>
    </Button>
    {open && <div id={id} className="chat-ui-field"><p>{renderParts(doc, state, node.details)}</p>
      {node.source && showSource && <ChatUiSource source={doc.sources[node.source]} />}
    </div>}
  </div>;
}
