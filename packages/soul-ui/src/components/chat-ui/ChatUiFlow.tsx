import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Node } from '@soulstream/chat-ui';

type Flow = Extract<Node, { kind: 'flow' }>;
type Cell = { col: number; row: number; box: DOMRect };
type Side = 'left' | 'right' | 'top' | 'bottom';
type Axis = 'x' | 'y';
type Port = { node: string; side: Side };
type Edge = Flow['edges'][number];
type Route = { start: Port; end: Port; gaps: { axis: Axis; index: number }[]; reverse?: boolean };

function routeEdge(edge: Edge, cells: Map<string, Cell>, columns: number, rows: number): Route {
  const a = cells.get(edge.from)!;
  const b = cells.get(edge.to)!;
  const across = b.col - a.col;
  const down = b.row - a.row;
  const horizontal = across > 0 ? 'right' : 'left';
  const vertical = down > 0 ? 'bottom' : 'top';
  const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const route = (start: Side, end: Side, gaps: Route['gaps'] = []): Route => ({
    start: { node: edge.from, side: start }, end: { node: edge.to, side: end }, gaps,
  });
  if (down === 0) {
    if (Math.abs(across) === 1) return route(horizontal, opposite[horizontal]);
    const side = a.row < rows ? 'bottom' : 'top';
    return route(side, side, [{ axis: 'y', index: side === 'bottom' ? a.row : a.row - 1 }]);
  }
  if (across === 0) {
    if (Math.abs(down) === 1) return route(vertical, opposite[vertical]);
    const side = a.col < columns ? 'right' : 'left';
    return route(side, side, [{ axis: 'x', index: side === 'right' ? a.col : a.col - 1 }]);
  }
  return route(horizontal, opposite[vertical], [
    { axis: 'x', index: across > 0 ? a.col : a.col - 1 },
    { axis: 'y', index: down > 0 ? b.row - 1 : b.row },
  ]);
}

function routePaths(edges: Edge[], cells: Map<string, Cell>, columns: number, rows: number, origin: DOMRect, gap: number) {
  const routes = edges.flatMap(edge => {
    const forward = routeEdge(edge, cells, columns, rows);
    return edge.both ? [forward, {
      start: { ...forward.start }, end: { ...forward.end }, gaps: forward.gaps.map(gap => ({ ...gap })), reverse: true,
    }] : [forward];
  });
  const ports = new Map<string, Port[]>();
  const lanes = new Map<string, Route['gaps']>();
  for (const { start, end, gaps } of routes) {
    for (const port of [start, end]) {
      const key = `${port.node}/${port.side}`;
      const group = ports.get(key) ?? [];
      group.push(port);
      ports.set(key, group);
    }
    for (const corridor of gaps) {
      const key = `${corridor.axis}/${corridor.index}`;
      const group = lanes.get(key) ?? [];
      group.push(corridor);
      lanes.set(key, group);
    }
  }
  const separation = <T,>(group: T[], item: T, available: number) =>
    (group.indexOf(item) - (group.length - 1) / 2) * Math.min(8, available / group.length);

  const clearance = 5;
  const portPoint = (port: Port) => {
    const box = cells.get(port.node)!.box;
    const across = port.side === 'left' || port.side === 'right';
    const offset = separation(ports.get(`${port.node}/${port.side}`)!, port, (across ? box.height : box.width) - 8);
    return across
      ? { x: box[port.side] - origin.x + (port.side === 'left' ? -clearance : clearance), y: box.top - origin.y + box.height / 2 + offset }
      : { x: box.left - origin.x + box.width / 2 + offset, y: box[port.side] - origin.y + (port.side === 'top' ? -clearance : clearance) };
  };

  const first = cells.values().next().value!;
  const gapCoordinate = (corridor: Route['gaps'][number]) => {
    const { axis, index } = corridor;
    const across = axis === 'x';
    const trackSize = across ? first.box.width : first.box.height;
    const firstTrack = across ? first.box.x - origin.x - (first.col - 1) * (trackSize + gap)
      : first.box.y - origin.y - (first.row - 1) * (trackSize + gap);
    const offset = separation(lanes.get(`${axis}/${index}`)!, corridor, gap - 2 * clearance);
    return firstTrack + index * (trackSize + gap) - gap / 2 + offset;
  };

  return routes.map(({ start, end, gaps, reverse }) => {
    const a = portPoint(start);
    const b = portPoint(end);
    const points = [a];
    const firstGap = gaps[0];
    if (firstGap) {
      const turn = gapCoordinate(firstGap);
      if (gaps[1]) {
        const cross = gapCoordinate(gaps[1]);
        points.push({ x: turn, y: a.y }, { x: turn, y: cross }, { x: b.x, y: cross });
      } else if (firstGap.axis === 'x') {
        points.push({ x: turn, y: a.y }, { x: turn, y: b.y });
      } else {
        points.push({ x: a.x, y: turn }, { x: b.x, y: turn });
      }
    }
    points.push(b);
    if (reverse) points.reverse();
    const d = 'M ' + points.map(point => `${point.x} ${point.y}`).join(' L ');
    return { from: reverse ? end.node : start.node, to: reverse ? start.node : end.node, d };
  });
}

function FlowLayout({ node, transposed }: { node: Flow; transposed: boolean }) {
  const marker = useId();
  const layout = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<ReturnType<typeof routePaths>>([]);
  const items = node.nodes.map(item => ({
    ...item, col: transposed ? item.row : item.col, row: transposed ? item.col : item.row,
  }));
  const columns = Math.max(...items.map(item => item.col));
  const rows = Math.max(...items.map(item => item.row));

  useLayoutEffect(() => {
    const el = layout.current!;
    const boxes = [...el.querySelectorAll<HTMLElement>('.chat-ui-flow-node')];
    const update = () => {
      if (!el.clientWidth) return;
      const cells = new Map(boxes.map((box, i) => [box.dataset.node!, {
        col: items[i]!.col, row: items[i]!.row, box: box.getBoundingClientRect(),
      }]));
      setPaths(routePaths(node.edges, cells, columns, rows, el.getBoundingClientRect(), parseFloat(getComputedStyle(el).columnGap)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    boxes.forEach(box => observer.observe(box));
    update();
    return () => observer.disconnect();
  }, [node, transposed, columns, rows]);

  const needsOutsideLane = (axis: 'row' | 'col') => node.edges.some(edge => {
    const a = items.find(item => item.id === edge.from)!;
    const b = items.find(item => item.id === edge.to)!;
    return Math.abs(a[axis] - b[axis]) > 1;
  });

  return <div ref={layout} className={`chat-ui-flow ${transposed ? 'chat-ui-flow-narrow' : 'chat-ui-flow-wide'}`}
    data-transposed={transposed} data-single-row={rows === 1 && needsOutsideLane('col')} data-single-column={columns === 1 && needsOutsideLane('row')}
    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
    <svg aria-hidden="true">
      <defs>
        <marker id={marker} viewBox="0 0 8 8" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
      {paths.map(({ from, to, d }) => <path key={`${from}/${to}`} data-from={from} data-to={to} d={d} markerEnd={`url(#${marker})`} />)}
    </svg>
    {items.map(item => <div key={item.id} className="chat-ui-flow-node" data-node={item.id} data-tone={item.tone}
      style={{ gridColumn: item.col, gridRow: item.row }}>
      <strong>{item.title}</strong>{item.note && <div className="chat-ui-display-meta">{item.note}</div>}
    </div>)}
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
