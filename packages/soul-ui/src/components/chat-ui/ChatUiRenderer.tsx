import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { isNodeVisible, renderParts, unreferencedSourceKeys, type Action, type ChatUiState, type FieldValue, type Node, type NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { ChatUiEntity, ChatUiSource } from './ChatUiEntity';
import { ChatUiCheckbox, ChatUiField, type RegisterNumberInput } from './ChatUiFields';

// The approved surface choice is owned here, including source actions and entities.
const BUTTON_VARIANTS = { default: 'outline', manuscript: 'outline' } as const;

export function ChatUiRenderer({ doc, state, onSet, onAction, presentation = 'default' }: {
  doc: NormalizedChatUiDocumentV1;
  state: ChatUiState;
  onSet: (field: string, value: FieldValue) => FieldValue;
  onAction: (action: Exclude<Action, { type: 'open_source' }>, nodeId: string) => void;
  presentation?: 'default' | 'manuscript';
}) {
  const prefix = useId();
  const variant = BUTTON_VARIANTS[presentation];
  const [openEntities, setOpenEntities] = useState<Record<string, boolean>>({});
  const [openSources, setOpenSources] = useState<Record<string, boolean>>({});
  const numberInputs = useRef(new Map<string, () => void>()).current;
  const registerNumberInput = useCallback<RegisterNumberInput>((id, synchronize) => {
    numberInputs.set(id, synchronize);
    return () => { numberInputs.delete(id); };
  }, [numberInputs]);
  const runAction = (action: Exclude<Action, { type: 'open_source' }>, nodeId: string) => {
    if (action.type === 'compose') numberInputs.forEach(synchronize => synchronize());
    onAction(action, nodeId);
  };
  const remainingSources = unreferencedSourceKeys(doc);
  const visibleNodes = (items: Node[]): Node[] => items.filter(node => isNodeVisible(doc, state, node)).flatMap(node => node.kind === 'group' ? [node, ...visibleNodes(node.children)] : [node]);
  const entitySources = new Set(visibleNodes(doc.body).flatMap(node => node.kind === 'entity' && openEntities[node.id] && node.source ? [node.source] : []));
  const bottomSources = remainingSources.filter(key => !entitySources.has(key));
  const nodes = (items: Node[], inline = false): ReactNode => {
    const visible = items.filter(node => isNodeVisible(doc, state, node));
    return <>{visible.map(node => {
    const body = (): ReactNode => {
      switch (node.kind) {
        case 'heading': {
          const Heading = `h${node.level}` as 'h1' | 'h2' | 'h3';
          return <Heading>{renderParts(doc, state, node.parts)}</Heading>;
        }
        case 'text': return <p>{node.emphasis === 'strong' ? <strong>{renderParts(doc, state, node.parts)}</strong> : renderParts(doc, state, node.parts)}</p>;
        case 'caption': return <p className="chat-ui-meta">{renderParts(doc, state, node.parts)}</p>;
        case 'group': return <div className={`chat-ui-group chat-ui-${node.layout}`}>{nodes(node.children, node.layout !== 'stack')}</div>;
        case 'slider': {
          const field = doc.fields[node.field];
          if (field.type !== 'number') throw new Error('slider requires a number field');
          const labelId = `${prefix}-${node.id}`;
          return <div className="chat-ui-field"><div className="chat-ui-between"><label id={labelId}>{node.label}</label><span>{renderParts(doc, state, [{ value: { field: node.field } }])}</span></div>
            <Slider aria-labelledby={labelId} value={state.values[node.field] as number} min={field.min} max={field.max} step={field.step}
              getAriaLabel={() => node.label} getAriaValueText={() => renderParts(doc, state, [{ value: { field: node.field } }])}
              onValueChange={value => onSet(node.field, Array.isArray(value) ? value[0] : value)} />
          </div>;
        }
        case 'checkbox': return <ChatUiCheckbox label={node.label} checked={state.values[node.field] === true} onChange={value => onSet(node.field, value)} />;
        case 'form': return <form noValidate className="chat-ui-group chat-ui-stack" onSubmit={event => { event.preventDefault(); runAction(node.action, node.id); }}>
          {node.items.map((item, index) => <ChatUiField key={`${item.field}-${index}`} field={doc.fields[item.field]} value={state.values[item.field]} label={item.label} onChange={value => onSet(item.field, value)} registerNumberInput={registerNumberInput} />)}
          <div className="chat-ui-actions"><Button type="submit" variant={variant}>{node.submitLabel}</Button></div>
        </form>;
        case 'button': return node.action.type === 'open_source'
          ? <ChatUiSource source={doc.sources[node.action.source]} label={node.label} variant={variant} open={!!openSources[node.id]} onOpenChange={open => setOpenSources(current => ({ ...current, [node.id]: open }))} showNote={!inline} noteId={inline ? `${prefix}-source-${node.id}` : undefined} />
          : <Button variant={variant} onClick={() => runAction(node.action as Exclude<Action, { type: 'open_source' }>, node.id)}>{node.label}</Button>;
        case 'entity': return <ChatUiEntity node={node} doc={doc} state={state} variant={variant} showSource={!!node.source && remainingSources.includes(node.source)} open={!!openEntities[node.id]} onOpenChange={open => setOpenEntities(current => ({ ...current, [node.id]: open }))} />;
        case 'citation': return <ChatUiSource source={doc.sources[node.source]} />;
      }
    };
    return <div key={node.id} className="chat-ui-node" data-chat-ui-node={node.id}>{body()}</div>;
    })}{inline && visible.map(node => {
      if (node.kind !== 'button' || node.action.type !== 'open_source' || !openSources[node.id]) return null;
      const source = doc.sources[node.action.source];
      return source.type === 'assumption' && source.note ? <p key={`note-${node.id}`} id={`${prefix}-source-${node.id}`} className="chat-ui-meta chat-ui-action-note">{source.note}</p> : null;
    })}</>;
  };
  return <div className="chat-ui" data-slot="chat-ui">
    {doc.title && <h2>{doc.title}</h2>}
    {nodes(doc.body)}
    {doc.assumptions.length > 0 && <p className="chat-ui-meta">가정: {doc.assumptions.join('; ')}</p>}
    {bottomSources.length > 0 && <div className="chat-ui-field chat-ui-meta">{bottomSources.map(key => <ChatUiSource key={key} source={doc.sources[key]} />)}</div>}
  </div>;
}
