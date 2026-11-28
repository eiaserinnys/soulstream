import { useId } from 'react';
import type { Node, NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';

type Line = Extract<Node, { kind: 'line' }>;
type Flow = Extract<Node, { kind: 'flow' }>;
export function ChatUiLine({ node, doc }: { node: Line; doc: NormalizedChatUiDocumentV1 }) {
  const points = node.series.flatMap(series => series.points);
  const values = points.map(point => point.y).concat(node.baseline ? [node.baseline.value] : []);
  const minY = Math.min(...values), maxY = Math.max(...values);
  const minX = Math.min(...points.map(point => Date.parse(point.x))), maxX = Math.max(...points.map(point => Date.parse(point.x)));
  const x = (time: string) => (Date.parse(time) - minX) / (maxX - minX || 1) * 100;
  const y = (value: number) => 100 - (value - minY) / (maxY - minY || 1) * 100;
  const unit = node.unit ? doc.units[node.unit]?.symbol ?? '' : '';
  const labels = node.series.map((series, index) => ({ index, value: series.points[series.points.length - 1]!.y, position: y(series.points[series.points.length - 1]!.y) })).sort((a, b) => a.position - b.position);
  labels.forEach((label, index) => { if (index) label.position = Math.max(label.position, labels[index - 1]!.position + 10); });
  if (labels.length && labels[labels.length - 1]!.position > 100) {
    labels[labels.length - 1]!.position = 100;
    for (let index = labels.length - 2; index >= 0; index--) labels[index]!.position = Math.min(labels[index]!.position, labels[index + 1]!.position - 10);
  }
  const date = (time: number) => new Date(time).toISOString().slice(5, 16).replace('T', ' ');
  const description = [node.label, ...node.series.map(series => `${series.label}: ${series.points[0]!.y}${unit} → ${series.points[series.points.length - 1]!.y}${unit}`)].filter(Boolean).join('; ');
  return <section className="chat-ui-display-container"><div className="chat-ui-chart-heading">{node.label && <div className="chat-ui-display-label">{node.label}</div>}{node.series.length > 1 && <div className="chat-ui-chart-legend">{node.series.map((series, index) => <span key={index} data-series={index}><i />{series.label}</span>)}</div>}</div>
    <div className="chat-ui-chart" role="img" aria-label={description}>
      <div className="chat-ui-chart-scale">{[0, 0.5, 1].filter(f => !node.baseline || Math.abs(y(node.baseline.value) - (100 - f * 100)) >= 10).map(f => <span key={f} style={{ top: `${100 - f * 100}%` }}>{(minY + f * (maxY - minY)).toLocaleString()}{unit}</span>)}{node.baseline && <span className="chat-ui-chart-limit-label" title={node.baseline.label} style={{ top: `${y(node.baseline.value)}%` }}>{node.baseline.value}{unit}</span>}</div>
      <div className="chat-ui-chart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{[0, 50, 100].map(position => <line key={position} className="chat-ui-chart-grid" x1="0" x2="100" y1={position} y2={position} />)}
          {node.baseline && <line className="chat-ui-chart-baseline" x1="0" x2="100" y1={y(node.baseline.value)} y2={y(node.baseline.value)} />}
          {node.series.map((series, index) => <polyline key={index} className="chat-ui-chart-series" data-series={index} points={series.points.map(point => `${x(point.x)},${y(point.y)}`).join(' ')} />)}
        </svg>
        {node.series.map((series, index) => { const last = series.points[series.points.length - 1]!; return <span key={index} className="chat-ui-chart-dot" data-series={index} style={{ left: `${x(last.x)}%`, top: `${y(last.y)}%` }} />; })}
      </div>
      <div className="chat-ui-chart-ends">{labels.map(label => <span key={label.index} data-series={label.index} style={{ top: `${label.position}%` }}>{label.value}{unit}</span>)}</div>
      <div className="chat-ui-chart-times"><span>{date(minX)}</span><span className="chat-ui-chart-middle">{date((minX + maxX) / 2)}</span><span>{date(maxX)}</span></div>
    </div>
  </section>;
}
function FlowLayout({ node, transposed }: { node: Flow; transposed: boolean }) {
  const id = useId();
  const columns = Math.max(...node.nodes.map(item => item.col));
  const rows = Math.max(...node.nodes.map(item => item.row));
  const width = transposed ? rows : columns;
  const height = transposed ? columns : rows;
  const point = (id: string) => {
    const item = node.nodes.find(entry => entry.id === id)!;
    return { x: ((transposed ? item.row : item.col) - 0.5) / width * 1000, y: ((transposed ? item.col : item.row) - 0.5) / height * 1000 };
  };
  const marker = `${id}-arrow`;
  return <div className={`chat-ui-flow ${transposed ? 'chat-ui-flow-narrow' : 'chat-ui-flow-wide'}`} data-transposed={transposed} style={{ gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${height}, 1fr)` }}>
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><defs><marker id={marker} viewBox="0 0 8 8" markerUnits="userSpaceOnUse" markerWidth="24" markerHeight="40" refX="7" refY="4" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" /></marker></defs>{node.edges.map((edge, i) => {
      const a = point(edge.from), b = point(edge.to), dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      const startX = a.x + dx * 400 / width, endX = b.x - dx * 400 / width;
      const startY = a.y + (dx ? 0 : dy * 400 / height), endY = b.y - (dy ? dy * 400 / height : 0);
      const d = dx && dy ? `M${startX} ${a.y} L${b.x} ${a.y} L${b.x} ${endY}` : `M${startX} ${startY} L${endX} ${endY}`;
      return <g key={i} data-axis={dx && !dy ? 'horizontal' : 'vertical'} data-both={edge.both}><path d={d} markerEnd={`url(#${marker})`} />{edge.both && <path d={d} markerStart={`url(#${marker})`} />}</g>;
    })}</svg>
    {node.nodes.map(item => <div key={item.id} className="chat-ui-flow-node" data-tone={item.tone} style={{ gridColumn: transposed ? item.row : item.col, gridRow: transposed ? item.col : item.row }}><strong>{item.title}</strong>{item.note && <div className="chat-ui-display-meta">{item.note}</div>}</div>)}
  </div>;
}
export function ChatUiFlow({ node }: { node: Flow }) {
  const transposable = Math.max(...node.nodes.map(item => item.col)) >= 3;
  const labels = node.nodes.map(item => [item.title, item.note].filter(Boolean).join(': '));
  const edges = node.edges.map(edge => `${node.nodes.find(item => item.id === edge.from)!.title} ${edge.both ? '↔' : '→'} ${node.nodes.find(item => item.id === edge.to)!.title}`);
  return <div className="chat-ui-display-container chat-ui-flow-container" data-transposable={transposable} role="img" aria-label={[...labels, ...edges].join('; ')}>
    <FlowLayout node={node} transposed={false} />
    {transposable && <FlowLayout node={node} transposed />}
  </div>;
}
