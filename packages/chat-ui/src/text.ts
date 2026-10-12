import { createEvaluationContext } from "./evaluate.js";
import { initialState } from "./controller.js";
import type {
  ChatUiState,
  Expr,
  FieldValue,
  Node,
  NormalizedChatUiDocumentV1,
  TextPart,
  Unit,
  Value,
  ValueRef,
} from "./types.js";

function expandExponential(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d*))?e([+-]?\d+)$/i.exec(value);
  if (!match) return value;
  const sign = match[1]!;
  const digits = `${match[2]}${match[3] ?? ""}`;
  const decimalPosition = match[2]!.length + Number(match[4]);
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function formatNumber(value: number, digits?: number): string {
  const places = digits ?? 2;
  let raw = expandExponential(value.toFixed(places));
  if (Number(raw) === 0) raw = places === 0 ? "0" : `0.${"0".repeat(places)}`;
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const dot = unsigned.indexOf(".");
  let integer = dot < 0 ? unsigned : unsigned.slice(0, dot);
  let fraction = dot < 0 ? "" : unsigned.slice(dot + 1);
  if (digits === undefined) fraction = fraction.replace(/0+$/, "");
  else fraction = fraction.padEnd(digits, "0").slice(0, digits);
  integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative && Number(raw) !== 0 ? "-" : "";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

function appendUnit(number: string, unit: Unit | undefined): string {
  if (!unit || !unit.symbol) return number;
  return /^[A-Za-z]/.test(unit.symbol) ? `${number} ${unit.symbol}` : `${number}${unit.symbol}`;
}

function displayUnitForRef(
  doc: NormalizedChatUiDocumentV1,
  ref: ValueRef,
  explicitUnit: string | undefined,
): Unit | undefined {
  if (explicitUnit) return doc.units[explicitUnit];
  if ("data" in ref) {
    const data = doc.data[ref.data]!;
    return data.unit ? doc.units[data.unit] : undefined;
  }
  if ("field" in ref) {
    const field = doc.fields[ref.field]!;
    return field.type === "number" ? doc.units[field.unit] : undefined;
  }
  return undefined;
}

function renderValue(
  doc: NormalizedChatUiDocumentV1,
  ref: ValueRef,
  value: Value,
  part: Exclude<TextPart, string>,
): string {
  if (value.type === "error") return `계산할 수 없음(${value.message})`;
  if (value.type === "boolean") return value.value ? "예" : "아니오";
  if (value.type === "string") {
    if ("field" in ref) {
      const field = doc.fields[ref.field]!;
      if (field.type === "choice") return field.options.find((option) => option.id === value.value)?.label ?? value.value;
    }
    return value.value;
  }
  if (value.type === "list") {
    if ("field" in ref) {
      const field = doc.fields[ref.field]!;
      if (field.type === "selection") {
        const labels = value.value.map((id) => field.options.find((option) => option.id === id)?.label ?? id);
        return labels.length ? labels.join(", ") : "선택 없음";
      }
    }
    return value.value.join(", ");
  }

  const format = part.format ?? "number";
  const displayUnit = displayUnitForRef(doc, ref, part.unit);
  const shown = format === "percent"
    ? formatNumber(value.base * 100, part.digits)
    : formatNumber(value.base / (displayUnit?.scale ?? 1), part.digits);
  return format === "plain" || format === "percent" ? `${shown}${format === "percent" ? "%" : ""}` : appendUnit(shown, displayUnit);
}

function renderPartsWithContext(
  doc: NormalizedChatUiDocumentV1,
  parts: TextPart[],
  evaluateExpression: (expr: Expr) => Value,
): string {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    const value = evaluateExpression({ op: "ref", ref: part.value });
    return renderValue(doc, part.value, value, part);
  }).join("");
}

export function renderParts(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
  parts: TextPart[],
): string {
  const context = createEvaluationContext(doc, state);
  return renderPartsWithContext(doc, parts, context.evaluateExpression);
}

function renderFieldValue(doc: NormalizedChatUiDocumentV1, state: ChatUiState, key: string): string {
  const field = doc.fields[key]!;
  const value = state.values[key] as FieldValue;
  if (field.type === "number") return appendUnit(formatNumber(value as number), doc.units[field.unit]);
  if (field.type === "text") return value as string;
  if (field.type === "boolean") return value ? "예" : "아니오";
  if (field.type === "choice") return field.options.find((option) => option.id === value)?.label ?? String(value);
  const labels = (value as string[]).map((id) => field.options.find((option) => option.id === id)?.label ?? id);
  return labels.length ? labels.join(", ") : "선택 없음";
}

function labelledLine(label: string, value: string): string {
  return value === "" ? `${label}:` : `${label}: ${value}`;
}

function isVisible(node: Node, evaluateExpression: (expr: Expr) => Value): boolean {
  if (!node.visibleWhen) return true;
  const result = evaluateExpression(node.visibleWhen);
  return result.type !== "boolean" || result.value;
}

function renderNode(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
  node: Node,
  evaluateExpression: (expr: Expr) => Value,
): string {
  if (node.kind === "heading") return `**${renderPartsWithContext(doc, node.parts, evaluateExpression)}**`;
  if (node.kind === "text") {
    const text = renderPartsWithContext(doc, node.parts, evaluateExpression);
    return node.emphasis === "strong" ? `**${text}**` : text;
  }
  if (node.kind === "caption") return renderPartsWithContext(doc, node.parts, evaluateExpression);
  if (node.kind === "group") return renderChildren(doc, state, node.children, evaluateExpression);
  if (node.kind === "slider") return labelledLine(node.label, renderFieldValue(doc, state, node.field));
  if (node.kind === "checkbox") return labelledLine(node.label, renderFieldValue(doc, state, node.field));
  if (node.kind === "form") {
    return node.items.map((item) => labelledLine(item.label, renderFieldValue(doc, state, item.field))).join("\n\n");
  }
  if (node.kind === "button") return `[${node.label}]`;
  if (node.kind === "entity") {
    return node.details.length
      ? labelledLine(node.label, renderPartsWithContext(doc, node.details, evaluateExpression))
      : node.label;
  }
  const source = doc.sources[node.source]!;
  return source.type === "assumption"
    ? `출처: ${source.label}`
    : `출처: [${source.label}](${source.url})`;
}

function renderChildren(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
  nodes: Node[],
  evaluateExpression: (expr: Expr) => Value,
): string {
  const blocks: string[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index]!;
    if (
      !isVisible(node, evaluateExpression)
      || (node.kind === "button" && node.action.type !== "compose")
    ) {
      index += 1;
      continue;
    }
    if (node.kind !== "button") {
      const rendered = renderNode(doc, state, node, evaluateExpression);
      if (rendered !== "") blocks.push(rendered);
      index += 1;
      continue;
    }
    const labels: string[] = [];
    let cursor = index;
    while (cursor < nodes.length) {
      const candidate = nodes[cursor]!;
      if (
        !isVisible(candidate, evaluateExpression)
        || (candidate.kind === "button" && candidate.action.type !== "compose")
      ) {
        cursor += 1;
        continue;
      }
      if (candidate.kind !== "button") break;
      labels.push(`[${candidate.label}]`);
      cursor += 1;
    }
    blocks.push(labels.join(" "));
    index = cursor;
  }
  return blocks.join("\n\n");
}

function collectCitationSources(nodes: Node[], sources = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === "citation") sources.add(node.source);
    if (node.kind === "group") collectCitationSources(node.children, sources);
  }
  return sources;
}

function renderUnreferencedSources(doc: NormalizedChatUiDocumentV1): string {
  const citedSources = collectCitationSources(doc.body);
  const entries = Object.keys(doc.sources)
    .sort()
    .filter((key) => !citedSources.has(key))
    .map((key) => {
      const source = doc.sources[key]!;
      return source.type === "assumption"
        ? source.label
        : `[${source.label}](${source.url})`;
    });
  return entries.length ? `출처: ${entries.join("; ")}` : "";
}

export function renderText(
  doc: NormalizedChatUiDocumentV1,
  state?: ChatUiState,
): string {
  const currentState = state ?? initialState(doc);
  const context = createEvaluationContext(doc, currentState);
  const blocks: string[] = [];
  if (doc.title !== undefined) blocks.push(`**${doc.title}**`);
  const body = renderChildren(doc, currentState, doc.body, context.evaluateExpression);
  if (body) blocks.push(body);
  if (doc.assumptions.length) blocks.push(`가정: ${doc.assumptions.join("; ")}`);
  const unreferencedSources = renderUnreferencedSources(doc);
  if (unreferencedSources) blocks.push(unreferencedSources);
  return blocks.join("\n\n");
}

function findNode(nodes: Node[], id: string): Node | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "group") {
      const nested = findNode(node.children, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function composeText(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
  nodeId: string,
): string {
  const node = findNode(doc.body, nodeId);
  if (!node) return "";
  if (node.kind !== "form" && node.kind !== "button") return "";
  if (node.action.type === "compose" && node.action.parts !== undefined) {
    return renderParts(doc, state, node.action.parts);
  }
  if (node.kind === "form") {
    return node.items
      .filter((item) => doc.fields[item.field]!.type !== "text" || state.values[item.field] !== "")
      .map((item) => labelledLine(item.label, renderFieldValue(doc, state, item.field)))
      .join("\n");
  }
  return renderText(doc, state);
}
