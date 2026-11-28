import { useLayoutEffect, useRef, useState } from 'react';
import { renderDisplayValue, renderDisplayValueParts, type ChatUiState, type DisplayValue, type Node, type NormalizedChatUiDocumentV1, type Tone } from '@soulstream/chat-ui';
import { useInternalLinkClick } from '../InternalLinkProvider';
import { StatusChip } from '../ui/status-chip';
import { ChatUiLine, ChartHeading } from './ChatUiDiagrams';
import { ChatUiFlow } from './ChatUiFlow';
import { ChatUiImage, ChatUiHtml } from './ChatUiMedia';
import { SourceLink } from '../SourceLink';
import './chat-ui-display.css';

type DisplayNode = Extract<Node, { kind: 'stats' | 'badge' | 'table' | 'list' | 'bars' | 'line' | 'steps' | 'compare' | 'flow' | 'image' | 'html' }>;
const toneNames: Record<Tone, string> = { neutral: 'open', good: 'running', warn: 'review', bad: 'error', info: 'done' };
const comparisonMarks = { yes: '✓', no: '×', partial: '−' };
function ChatUiBadge({ label, tone }: { label: string; tone: Tone }) {
  return <StatusChip label={label} tone={toneNames[tone]} />;
}

type DisplayContext = { doc: NormalizedChatUiDocumentV1; state: ChatUiState };

function Stats({ node, doc, state }: DisplayContext & { node: Extract<DisplayNode, { kind: 'stats' }> }) {
  return <section className="chat-ui-display-container">
    {node.label && <div className="chat-ui-display-label">{node.label}</div>}
    <div className={`chat-ui-stats chat-ui-stats-${node.tiles.length}`}>
      {node.tiles.map((tile, i) => {
        const { text, symbol } = renderDisplayValueParts(doc, state, tile.value, tile.unit);
        return <div className="chat-ui-stat" data-tone={tile.tone} key={i}>
          <div className="chat-ui-stat-label"><span className="chat-ui-tone-dot" />{tile.label}</div>
          <div className="chat-ui-stat-value"><span>{text}</span>{symbol && <span className="chat-ui-stat-unit chat-ui-display-meta">{symbol}</span>}</div>
          {tile.note && <div className="chat-ui-display-meta">{tile.note}</div>}
        </div>;
      })}
    </div>
  </section>;
}

function List({ node, doc, state }: DisplayContext & { node: Extract<DisplayNode, { kind: 'list' }> }) {
  const handleLink = useInternalLinkClick();
  return <section>
    {node.label && <div className="chat-ui-display-label">{node.label}</div>}
    <div className="chat-ui-list">{node.items.map((item, i) => {
      const children = <>
        <div className="chat-ui-list-title">{node.numbered && <span>{i + 1}. </span>}{item.title}</div>
        {item.note && <div className="chat-ui-display-meta chat-ui-list-note">{item.note}</div>}
        {item.badge && <div className="chat-ui-list-badge"><ChatUiBadge {...item.badge} /></div>}
        {item.value !== undefined && <div className="chat-ui-display-meta chat-ui-list-value">{renderDisplayValue(doc, state, item.value)}</div>}
      </>;
      return item.url
        ? <a key={item.id} className="chat-ui-list-row" href={item.url} target="_blank" rel="noopener noreferrer" onClick={handleLink}>{children}</a>
        : <div key={item.id} className="chat-ui-list-row">{children}</div>;
    })}</div>
  </section>;
}

function Bars({ node, doc }: { node: Extract<DisplayNode, { kind: 'bars' }>; doc: NormalizedChatUiDocumentV1 }) {
  const max = node.max ?? Math.max(0, ...node.items.flatMap(item => Array.isArray(item.value) ? item.value : [item.value]));
  const unit = node.unit ? doc.units[node.unit]?.symbol : undefined;
  return <section className="chat-ui-display-container">
    <ChartHeading label={node.label} series={node.series} />
    <div className="chat-ui-bars">{node.items.map((item, i) => {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      return <div key={i} className="chat-ui-bar-row" data-excluded={item.excluded}>
        <span className="chat-ui-bar-label" title={item.label}>{item.label}</span>
        <div>{values.map((value, j) => <div className="chat-ui-bar-track" key={j}>
          <div className="chat-ui-bar-fill" data-series={j} data-tone={node.series ? undefined : item.tone} style={{ width: `${max > 0 ? value / max * 100 : 0}%` }} />
        </div>)}</div>
        <span className="chat-ui-display-meta">{values.join(' / ')}{unit}</span>
      </div>;
    })}</div>
  </section>;
}

export function ChatUiDisplay({ node, doc, state, sessionId, imageUrl }: DisplayContext & { node: DisplayNode; sessionId?: string; imageUrl?: (attachmentId: string) => string }) {
  switch (node.kind) {
    case 'stats': return <Stats node={node} doc={doc} state={state} />;
    case 'badge': return <ChatUiBadge label={node.label} tone={node.tone} />;
    case 'table': return <ChatUiTable node={node} doc={doc} state={state} />;
    case 'list': return <List node={node} doc={doc} state={state} />;
    case 'bars': return <Bars node={node} doc={doc} />;
    case 'line': return <ChatUiLine node={node} doc={doc} />;
    case 'steps': return <div className="chat-ui-steps">{node.items.map((item, i) => <div className="chat-ui-step" data-state={item.state} key={i}><span className="chat-ui-step-dot" /><div><div className="chat-ui-step-title">{item.title}</div>{item.note && <div className="chat-ui-display-meta">{item.note}</div>}</div>{item.time && <span className="chat-ui-display-meta">{item.time}</span>}</div>)}</div>;
    case 'compare': return <div className="chat-ui-display-container"><div className="chat-ui-compare" data-columns={node.columns.length}>{node.columns.map(column => <div className="chat-ui-compare-column" data-selected={column.selected} key={column.id}>
      <div className="chat-ui-display-label">{column.title}</div>
      {column.items.map((item, i) => <div className="chat-ui-compare-item" key={i}>
        <span aria-hidden="true">{item.mark && comparisonMarks[item.mark]}</span>
        <div>{renderDisplayValue(doc, state, item.text)}</div>
      </div>)}
    </div>)}</div></div>;
    case 'flow': return <ChatUiFlow node={node} />;
    case 'image': return <ChatUiImage node={node} sessionId={sessionId} imageUrl={imageUrl?.(node.attachment_id)} />;
    case 'html': return <ChatUiHtml node={node} />;
  }
}

type Table = Extract<Node, { kind: 'table' }>;

function ChatUiTable({ node, doc, state }: { node: Table; doc: NormalizedChatUiDocumentV1; state: ChatUiState }) {
  const frame = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const [{ scrolled, moreRight }, setScrollEdges] = useState({ scrolled: false, moreRight: false });

  useLayoutEffect(() => {
    const viewport = frame.current!;
    const update = () => {
      const scrolled = viewport.scrollLeft > 0;
      const moreRight = viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1;
      setScrollEdges(previous => previous.scrolled === scrolled && previous.moreRight === moreRight ? previous : { scrolled, moreRight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(table.current!);
    viewport.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return <section className="chat-ui-display-container">
    {node.label && <div className="chat-ui-display-label">{node.label}</div>}
    <div className="chat-ui-table-scroll" data-scrolled={scrolled} data-more-right={moreRight}>
      <div className="chat-ui-table-frame" ref={frame} tabIndex={0} role={node.label ? 'region' : undefined} aria-label={node.label}>
        <table ref={table}>
          <thead><tr>{node.columns.map(column => <th key={column.key} scope="col" data-numeric={column.type === 'number'}>{column.label}</th>)}</tr></thead>
          <tbody>{node.rows.map((row, i) => <tr key={i}>{node.columns.map(column => {
            const value = row[column.key];
            return <td key={column.key} data-wrap={column.wrap} data-numeric={column.type === 'number'}>{
              value == null ? null : typeof value === 'object' && 'label' in value
                ? 'tone' in value ? <ChatUiBadge {...value} /> : <SourceLink href={value.url} className="chat-ui-source">{value.label}</SourceLink>
                : renderDisplayValue(doc, state, value, column.unit)
            }</td>;
          })}</tr>)}</tbody>
        </table>
      </div>
    </div>
  </section>;
}
