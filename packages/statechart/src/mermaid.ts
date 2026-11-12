/**
 * XState v5 StateNode 구조에서 Mermaid stateDiagram-v2 글을 뽑는다.
 *
 * xstate 패키지를 import하지 않는다. XState v5 StateNode와 같은 모양의 구조 타입만
 * 받으므로 `toMermaid(machine.root, spec)`처럼 실제 기계 루트를 그대로 넘길 수 있다.
 * 그림의 범위와 표시는 전부 ChartSpec이 정하고, 이 모듈은 카드나 소울스트림 도메인을
 * 알지 못한다.
 */

export interface ChartTransition {
  eventType: string;
  target?: readonly ChartNode[] | undefined;
  source: ChartNode;
  description?: string;
  meta?: Record<string, unknown> | undefined;
}

export interface ChartNode {
  id: string;
  key: string;
  type: "atomic" | "compound" | "parallel" | "final" | "history";
  description?: string | undefined;
  tags?: readonly string[] | undefined;
  meta?: Record<string, unknown> | undefined;
  states: Record<string, ChartNode>;
  on: Record<string, readonly ChartTransition[]>;
  parent?: ChartNode | undefined;
}

export interface ChartHole {
  id: string;
  parent: string;
  label: string;
  reachable: boolean;
  note?: string;
  incoming?: { from: string; label: string }[];
}

export interface ChartSpec {
  include: string[];
  /** Show targetless transitions as self edges in a diagnostic view. */
  targetless?: boolean;
  hide?: string[];
  collapse?: string[];
  parallel?: "stack" | "divider";
  groups?: Record<string, { from: string; to: string; label: string }>;
  hideEvents?: string[];
  marks?: {
    states?: string[];
    transitions?: { source: string; event: string; note: string }[];
  };
  holes?: ChartHole[];
}

const INDENT = "    ";
const HOLE_PREFIX = "hole_";
const STAR_MARK = " *";
const EDGE_LIMIT = 25;
const BREAKS_CLASS_DEF = "classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2px,color:#cd2834";
const HOLE_CLASS_DEF = "classDef hole fill:#ffffff,stroke:#9a9a9a,stroke-dasharray:4 3";

interface Box {
  id: string;
  node: ChartNode;
  name: string;
  collapsed: boolean;
  block: boolean;
  parent: Box | null;
  children: Box[];
  holes: ChartHole[];
}

export function toMermaid(
  root: ChartNode,
  spec: ChartSpec,
): { mermaid: string; edgeCount: number; warnings: string[] } {
  const warnings: string[] = [];

  // 1. 상태 찾기: 깊이 우선으로 훑어 id -> 노드 표를 만든다.
  const nodes = new Map<string, ChartNode>();
  const order: ChartNode[] = [];
  const collect = (node: ChartNode): void => {
    nodes.set(node.id, node);
    order.push(node);
    for (const child of Object.values(node.states)) collect(child);
  };
  collect(root);

  const requireNode = (id: string, where: string): void => {
    if (!nodes.has(id)) throw new Error(`${where} refers to unknown state id "${id}"`);
  };
  const groups = spec.groups ?? {};
  for (const id of spec.include) requireNode(id, "include");
  for (const id of spec.hide ?? []) requireNode(id, "hide");
  for (const id of spec.collapse ?? []) requireNode(id, "collapse");
  for (const group of Object.values(groups)) {
    requireNode(group.from, "groups.from");
    requireNode(group.to, "groups.to");
  }
  for (const id of spec.marks?.states ?? []) requireNode(id, "marks.states");
  for (const mark of spec.marks?.transitions ?? []) requireNode(mark.source, "marks.transitions");
  for (const hole of spec.holes ?? []) {
    requireNode(hole.parent, `hole ${hole.id}`);
    for (const incoming of hole.incoming ?? []) requireNode(incoming.from, `hole ${hole.id} incoming`);
  }

  // 2. 보이는 자리 정하기
  const hideSet = new Set(spec.hide ?? []);
  const collapseSet = new Set(spec.collapse ?? []);
  const includeSet = new Set(spec.include);
  const hidden = new Set<string>();
  const included = new Set<string>();
  const walkVisibility = (node: ChartNode, hiddenAbove: boolean, includedAbove: boolean): void => {
    const isHidden = hiddenAbove || hideSet.has(node.id);
    const isIncluded = includedAbove || includeSet.has(node.id);
    if (isHidden) hidden.add(node.id);
    if (isIncluded) included.add(node.id);
    for (const child of Object.values(node.states)) walkVisibility(child, isHidden, isIncluded);
  };
  walkVisibility(root, false, false);

  const collapseTarget = new Map<string, string>();
  const walkCollapse = (node: ChartNode, collapsedAbove: string | null): void => {
    const target = collapseSet.has(node.id) ? node.id : collapsedAbove;
    if (target !== null) collapseTarget.set(node.id, target);
    for (const child of Object.values(node.states)) walkCollapse(child, target);
  };
  walkCollapse(root, null);

  const resolve = (id: string): string | null => {
    if (!nodes.has(id) || hidden.has(id)) return null;
    const target = collapseTarget.get(id) ?? id;
    return included.has(target) ? target : null;
  };

  // 3~5. 그릴 상자 트리
  const boxes = new Map<string, Box>();
  const buildBox = (id: string, parent: Box | null): Box => {
    const box: Box = {
      id,
      node: nodes.get(id)!,
      name: "",
      collapsed: collapseSet.has(id),
      block: false,
      parent,
      children: [],
      holes: [],
    };
    boxes.set(id, box);
    for (const child of Object.values(box.node.states)) {
      if (resolve(child.id) === child.id) box.children.push(buildBox(child.id, box));
    }
    return box;
  };

  const drawn = new Set<string>();
  const markDrawn = (box: Box): void => {
    drawn.add(box.id);
    for (const child of box.children) markDrawn(child);
  };
  const top: Box[] = [];
  for (const id of spec.include) {
    if (drawn.has(id) || resolve(id) !== id) continue;
    const box = buildBox(id, null);
    top.push(box);
    markDrawn(box);
  }

  const mergedHoles = new Map<string, ChartHole[]>();
  for (const hole of spec.holes ?? []) {
    const parentId = resolve(hole.parent);
    const parentBox = parentId === null ? undefined : boxes.get(parentId);
    if (parentBox === undefined) {
      warnings.push(`hole ${hole.id}: parent ${hole.parent} is not visible`);
      continue;
    }
    if (parentBox.collapsed) {
      const merged = mergedHoles.get(parentBox.id);
      if (merged === undefined) mergedHoles.set(parentBox.id, [hole]);
      else merged.push(hole);
      continue;
    }
    parentBox.holes.push(hole);
  }

  const usedNames = new Set<string>();
  const allocate = (base: string): string => {
    let name = base;
    let counter = 2;
    while (usedNames.has(name)) {
      name = `${base}_${counter}`;
      counter += 1;
    }
    usedNames.add(name);
    return name;
  };
  const sanitizeName = (id: string): string => id.replace(/[^A-Za-z0-9_]/g, "_");

  const holeNames = new Map<string, string>();
  const nameBox = (box: Box): void => {
    box.block = !box.collapsed && (box.children.length > 0 || box.holes.length > 0);
    box.name = allocate(sanitizeName(box.id));
    for (const child of box.children) nameBox(child);
    for (const hole of box.holes) {
      holeNames.set(hole.id, allocate(`${HOLE_PREFIX}${sanitizeName(hole.id)}`));
    }
  };
  for (const box of top) nameBox(box);

  const cleanLabel = (text: string): string => text.replace(/"/g, "'").replace(/\r?\n/g, " ");
  const stateLabel = (node: ChartNode): string => {
    const base = node.description ?? node.key;
    return cleanLabel(node.tags?.includes("unnamed") === true ? `${base}${STAR_MARK}` : base);
  };
  const holeLabel = (hole: ChartHole): string => {
    const base = `${hole.label}${STAR_MARK}`;
    return cleanLabel(hole.reachable && hole.note !== undefined ? `${base} (${hole.note})` : base);
  };
  const cleanEdgeLabel = (text: string): string => text.replace(/\r?\n/g, " ").replace(/;/g, ",");

  // 6~8. 화살표 모으기와 적을 자리
  const nameOf = (id: string): string => boxes.get(id)!.name;
  const edgeLines = new Map<string, string[]>();
  const appendEdge = (block: Box | null, line: string): void => {
    const key = block === null ? "" : block.id;
    const bucket = edgeLines.get(key);
    if (bucket === undefined) edgeLines.set(key, [line]);
    else bucket.push(line);
  };

  // 블록 안에 적은 화살표는 렌더러가 두 끝을 그 블록의 직속 자식으로 끌어들인다.
  // 그래서 두 끝이 같은 블록의 직속 자식일 때만 그 블록 안에 적고 나머지는 맨 바깥에 적는다.
  const divider = (spec.parallel ?? "stack") === "divider";
  const isDividerParallel = (box: Box): boolean => divider && box.node.type === "parallel";

  const edgeBlock = (srcId: string, tgtId: string): Box | null => {
    const parent = boxes.get(srcId)!.parent;
    if (parent !== null && parent === boxes.get(tgtId)!.parent && !isDividerParallel(parent)) return parent;
    return null;
  };

  const holeEdgeBlock = (srcId: string, parentBox: Box): Box | null => {
    const srcBox = boxes.get(srcId)!;
    if (srcBox.parent !== null && srcBox.parent === parentBox && !isDividerParallel(parentBox)) return parentBox;
    return null;
  };

  let edgeCount = 0;
  const seenEdges = new Set<string>();

  const addStateEdge = (srcId: string, tgtId: string, label: string): void => {
    const key = `state\u0000${srcId}\u0000${tgtId}\u0000${label}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    appendEdge(edgeBlock(srcId, tgtId), `${nameOf(srcId)} --> ${nameOf(tgtId)}: ${label}`);
    edgeCount += 1;
  };

  const addHoleArrow = (srcId: string, hole: ChartHole, label: string): void => {
    const targetId = resolve(hole.parent)!;
    const drawnName = holeNames.get(hole.id);
    if (drawnName !== undefined) {
      const key = `hole\u0000${srcId}\u0000${hole.id}\u0000${label}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      const parentBox = boxes.get(targetId)!;
      appendEdge(holeEdgeBlock(srcId, parentBox), `${nameOf(srcId)} --> ${drawnName}: ${label}`);
      edgeCount += 1;
      return;
    }
    if (targetId === srcId) return;
    addStateEdge(srcId, targetId, label);
  };

  const markNotes = new Map<string, string>();
  for (const mark of spec.marks?.transitions ?? []) {
    markNotes.set(`${mark.source}\u0000${mark.event}`, mark.note);
  }

  const hideEvents = new Set(spec.hideEvents ?? []);
  const emittedGroups = new Set<string>();
  for (const node of order) {
    for (const eventType of Object.keys(node.on)) {
      if (hideEvents.has(eventType)) continue;
      for (const transition of node.on[eventType] ?? []) {
        if ((transition.target === undefined || transition.target.length === 0) && !spec.targetless) continue;
        const groupName = typeof transition.meta?.chartGroup === "string" ? transition.meta.chartGroup : null;
        if (groupName !== null) {
          const group = groups[groupName];
          if (group === undefined) throw new Error(`unknown transition group "${groupName}"`);
          if (emittedGroups.has(groupName) || resolve(transition.source.id) === null) continue;
          emittedGroups.add(groupName);
          const fromId = resolve(group.from);
          const toId = resolve(group.to);
          if (fromId === null || toId === null) continue;
          addStateEdge(fromId, toId, cleanEdgeLabel(group.label));
          continue;
        }
        const srcId = resolve(transition.source.id);
        if (srcId === null) continue;
        const note = markNotes.get(`${transition.source.id}\u0000${eventType}`);
        const base = transition.description ?? eventType;
        const label = cleanEdgeLabel(note === undefined ? base : `${base} (${note})`);
        for (const targetNode of transition.target?.length ? transition.target : [transition.source]) {
          const tgtId = resolve(targetNode.id);
          if (tgtId === null) continue;
          if (srcId === tgtId && transition.source.id !== targetNode.id) continue;
          addStateEdge(srcId, tgtId, label);
        }
      }
    }
  }

  // 9. 구멍으로 들어오는 화살표
  for (const hole of spec.holes ?? []) {
    if (resolve(hole.parent) === null) continue;
    for (const incoming of hole.incoming ?? []) {
      const fromId = resolve(incoming.from);
      if (fromId === null) continue;
      addHoleArrow(fromId, hole, cleanEdgeLabel(incoming.label));
    }
  }

  // 10~13. 글 조립
  const lines: string[] = [
    "stateDiagram-v2",
    "direction TB",
    BREAKS_CLASS_DEF,
    HOLE_CLASS_DEF,
  ];

  const renderBox = (box: Box, depth: number): void => {
    const pad = INDENT.repeat(depth);
    const inner = INDENT.repeat(depth + 1);
    lines.push(`${pad}state "${stateLabel(box.node)}" as ${box.name}${box.block ? " {" : ""}`);
    if (!box.block) return;
    lines.push(`${inner}direction TB`);
    box.children.forEach((child, index) => {
      if (index > 0 && divider && box.node.type === "parallel") lines.push(`${inner}--`);
      renderBox(child, depth + 1);
    });
    for (const hole of box.holes) {
      lines.push(`${inner}state "${holeLabel(hole)}" as ${holeNames.get(hole.id)!}`);
    }
    for (const edge of edgeLines.get(box.id) ?? []) lines.push(`${inner}${edge}`);
    lines.push(`${pad}}`);
  };

  for (const box of top) renderBox(box, 0);
  for (const edge of edgeLines.get("") ?? []) lines.push(edge);

  const paintedNames = new Set<string>();
  const paint = (name: string, kind: "breaks" | "hole"): void => {
    if (paintedNames.has(name)) return;
    paintedNames.add(name);
    lines.push(`class ${name} ${kind}`);
  };
  for (const id of spec.marks?.states ?? []) {
    const resolved = resolve(id);
    if (resolved !== null) paint(nameOf(resolved), "breaks");
  }
  for (const hole of spec.holes ?? []) {
    const drawnName = holeNames.get(hole.id);
    if (drawnName !== undefined) {
      paint(drawnName, hole.reachable ? "breaks" : "hole");
      continue;
    }
    const targetId = resolve(hole.parent);
    if (targetId === null) continue;
    const merged = mergedHoles.get(targetId);
    if (merged === undefined) continue;
    paint(nameOf(targetId), merged.some((entry) => entry.reachable) ? "breaks" : "hole");
  }

  if (edgeCount > EDGE_LIMIT) warnings.push(`too many edges: ${edgeCount}`);

  return { mermaid: lines.join("\n"), edgeCount, warnings };
}
