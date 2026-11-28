import type { Node, NormalizedChatUiDocumentV1 } from '@soulstream/chat-ui';

type Line = Extract<Node, { kind: 'line' }>;
export function ChartHeading({ label, series }: { label?: string; series?: { label: string }[] }) {
  if (!label && !series) return null;
  return <div className="chat-ui-chart-heading">
    {label && <div className="chat-ui-display-label">{label}</div>}
    {series && <div className="chat-ui-chart-legend">{series.map((item, index) =>
      <span key={index} data-series={index}><i />{item.label}</span>
    )}</div>}
  </div>;
}

function chartTicks(min: number, max: number, unit: string) {
  if (unit === '%') return [0, 50, 100] as const;
  const span = max - min || Math.abs(max) || 1;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const step = [0.5, 1, 2, 2.5, 5, 10].map(factor => factor * magnitude)
    .find(candidate => (Math.floor(min / candidate) + 2) * candidate >= max)!;
  const start = Math.floor(min / step);
  return [start * step, (start + 1) * step, (start + 2) * step] as const;
}

export function ChatUiLine({ node, doc }: { node: Line; doc: NormalizedChatUiDocumentV1 }) {
  const points = node.series.flatMap(series => series.points);
  const values = points.map(point => point.y).concat(node.baseline ? [node.baseline.value] : []);
  const unit = node.unit ? doc.units[node.unit]?.symbol ?? '' : '';
  const ticks = chartTicks(Math.min(...values), Math.max(...values), unit);
  const [minY, , maxY] = ticks;
  const minX = Math.min(...points.map(point => Date.parse(point.x))), maxX = Math.max(...points.map(point => Date.parse(point.x)));
  const x = (time: string) => (Date.parse(time) - minX) / (maxX - minX || 1) * 100;
  const y = (value: number) => 100 - (value - minY) / (maxY - minY || 1) * 100;
  const labels = node.series.map((series, index) => ({ index, value: series.points[series.points.length - 1]!.y, position: y(series.points[series.points.length - 1]!.y) })).sort((a, b) => a.position - b.position);
  labels.forEach((label, index) => { if (index) label.position = Math.max(label.position, labels[index - 1]!.position + 10); });
  if (labels.length && labels[labels.length - 1]!.position > 100) {
    labels[labels.length - 1]!.position = 100;
    for (let index = labels.length - 2; index >= 0; index--) labels[index]!.position = Math.min(labels[index]!.position, labels[index + 1]!.position - 10);
  }
  const sameDay = new Date(minX).toDateString() === new Date(maxX).toDateString();
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
  });
  const baselineY = node.baseline && y(node.baseline.value);
  const labelY = baselineY === undefined ? undefined : [0, 50, 100].reduce(
    (position, tick) => Math.abs(tick - position) < 10 ? tick + (tick > position ? -10 : 10) : position,
    baselineY,
  );
  const description = [node.label, ...node.series.map(series => `${series.label}: ${series.points[0]!.y}${unit} → ${series.points[series.points.length - 1]!.y}${unit}`)].filter(Boolean).join('; ');
  return <section className="chat-ui-display-container"><ChartHeading label={node.label} series={node.series.length > 1 ? node.series : undefined} />
    <div className="chat-ui-chart" role="img" aria-label={description}>
      <div className="chat-ui-chart-scale">{ticks.map(value => <span key={value} style={{ top: `${y(value)}%` }}>{value.toLocaleString(undefined, { maximumFractionDigits: 12 })}{unit}</span>)}
        {node.baseline && !ticks.some(value => value === node.baseline?.value) && <span className="chat-ui-chart-limit-label" title={node.baseline.label} style={{ top: `${labelY}%` }}>{node.baseline.value}{unit}</span>}
      </div>
      <div className="chat-ui-chart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{[0, 50, 100].map(position => <line key={position} className="chat-ui-chart-grid" x1="0" x2="100" y1={position} y2={position} />)}
          {node.baseline && <line className="chat-ui-chart-baseline" x1="0" x2="100" y1={y(node.baseline.value)} y2={y(node.baseline.value)} />}
          {node.series.map((series, index) => <polyline key={index} className="chat-ui-chart-series" data-series={index} points={series.points.map(point => `${x(point.x)},${y(point.y)}`).join(' ')} />)}
        </svg>
        {node.series.map((series, index) => { const last = series.points[series.points.length - 1]!; return <span key={index} className="chat-ui-chart-dot" data-series={index} style={{ left: `${x(last.x)}%`, top: `${y(last.y)}%` }} />; })}
      </div>
      <div className="chat-ui-chart-ends">{labels.map(label => <span key={label.index} data-series={label.index} style={{ top: `${label.position}%` }}>{label.value}{unit}</span>)}</div>
      <div className="chat-ui-chart-times"><span>{formatter.format(minX)}</span><span className="chat-ui-chart-middle">{formatter.format((minX + maxX) / 2)}</span><span>{formatter.format(maxX)}</span></div>
    </div>
  </section>;
}
