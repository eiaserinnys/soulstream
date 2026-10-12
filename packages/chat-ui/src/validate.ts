import { checkStructure } from "./validate_structure.js";
import { addIssue, hasOwn, MAX_ISSUES } from "./validate_utils.js";
import type {
  Action,
  ChatUiDocumentV1,
  DataValue,
  Expr,
  Field,
  Key,
  Node,
  NormalizedChatUiDocumentV1,
  TextPart,
  Unit,
  ValidationIssue,
  ValidationResult,
  ValueRef,
} from "./types.js";

type StaticType =
  | { kind: "number"; dims: Record<string, number> }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "list" };
function sameDims(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function sameType(left: StaticType, right: StaticType): boolean {
  return left.kind === right.kind && (left.kind !== "number" || (right.kind === "number" && sameDims(left.dims, right.dims)));
}

function combineDims(args: StaticType[], subtract?: StaticType): Record<string, number> {
  const dims: Record<string, number> = {};
  for (const arg of args) {
    if (arg.kind !== "number") continue;
    for (const key of Object.keys(arg.dims)) dims[key] = (dims[key] ?? 0) + arg.dims[key]!;
  }
  if (subtract?.kind === "number") {
    for (const key of Object.keys(subtract.dims)) dims[key] = (dims[key] ?? 0) - subtract.dims[key]!;
  }
  for (const key of Object.keys(dims)) if (dims[key] === 0) delete dims[key];
  return Object.fromEntries(Object.keys(dims).sort().map((key) => [key, dims[key]!])) as Record<string, number>;
}

function checkSemantics(doc: NormalizedChatUiDocumentV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issueKeys = new Set<string>();
  const report = (path: string, reason: string): void => {
    const key = `${path}\n${reason}`;
    if (issueKeys.has(key) || issues.length >= MAX_ISSUES) return;
    issueKeys.add(key);
    addIssue(issues, path, reason);
  };
  const computedTypes = new Map<string, StaticType | null>();
  const activeComputed = new Set<string>();
  const unitAt = (key: string): Unit | undefined => hasOwn(doc.units, key) ? doc.units[key] : undefined;
  const fieldAt = (key: string): Field | undefined => hasOwn(doc.fields, key) ? doc.fields[key] : undefined;
  const dataAt = (key: string): DataValue | undefined => hasOwn(doc.data, key) ? doc.data[key] : undefined;

  const typeOfRef = (ref: ValueRef, path: string): StaticType | undefined => {
    if ("data" in ref) {
      const key = ref.data;
      const data = dataAt(key);
      if (!data) {
        report(`${path}.data`, `data '${key}'를 찾을 수 없습니다.`);
        return undefined;
      }
      if (typeof data.value === "number") {
        if (!data.unit || !unitAt(data.unit)) {
          report(`${path}.data`, `data '${key}'의 단위를 찾을 수 없습니다.`);
          return undefined;
        }
        return { kind: "number", dims: unitAt(data.unit)!.dims };
      }
      return { kind: typeof data.value === "string" ? "string" : "boolean" };
    }
    if ("field" in ref) {
      const key = ref.field;
      const field = fieldAt(key);
      if (!field) {
        report(`${path}.field`, `field '${key}'를 찾을 수 없습니다.`);
        return undefined;
      }
      if (field.type === "number") {
        const unit = unitAt(field.unit);
        if (!unit) {
          report(`${path}.field`, `field '${key}'의 단위를 찾을 수 없습니다.`);
          return undefined;
        }
        return { kind: "number", dims: unit.dims };
      }
      if (field.type === "text" || field.type === "choice") return { kind: "string" };
      if (field.type === "boolean") return { kind: "boolean" };
      return { kind: "list" };
    }
    const key = (ref as { computed: Key }).computed;
    return inferComputed(key, path);
  };

  const inferExpr = (expr: Expr, path: string): StaticType | undefined => {
    if (expr.op === "const") {
      if (typeof expr.value === "number") {
        const unit = expr.unit ? unitAt(expr.unit) : undefined;
        if (!unit) {
          report(`${path}.unit`, "숫자 const에는 존재하는 unit이 필요합니다.");
          return undefined;
        }
        return { kind: "number", dims: unit.dims };
      }
      return { kind: typeof expr.value === "string" ? "string" : "boolean" };
    }
    if (expr.op === "ref") return typeOfRef(expr.ref, `${path}.ref`);
    const argTypes = expr.args.map((arg, index) => inferExpr(arg, `${path}.args[${index}]`));
    if (argTypes.some((type) => !type)) return undefined;
    const args = argTypes as StaticType[];
    if (expr.op === "add" || expr.op === "sub") {
      const first = args[0]!;
      if (first.kind !== "number") {
        report(`${path}.args[0]`, `${expr.op} 인자는 같은 차원의 number여야 합니다.`);
        return undefined;
      }
      for (let index = 1; index < args.length; index += 1) {
        const current = args[index]!;
        if (current.kind !== "number" || !sameDims(first.dims, current.dims)) {
          report(`${path}.args[${index}]`, `${expr.op} 인자는 같은 차원의 number여야 합니다.`);
        }
      }
      return { kind: "number", dims: first.dims };
    }
    if (expr.op === "mul" || expr.op === "div") {
      for (let index = 0; index < args.length; index += 1) {
        if (args[index]!.kind !== "number") report(`${path}.args[${index}]`, `${expr.op} 인자는 number여야 합니다.`);
      }
      return { kind: "number", dims: expr.op === "div" ? combineDims([args[0]!], args[1]!) : combineDims(args) };
    }
    if (expr.op === "eq") {
      if (args[0]!.kind === "list" || args[1]!.kind === "list" || !sameType(args[0]!, args[1]!)) {
        report(`${path}.args[1]`, "eq 인자는 같은 타입이어야 합니다.");
      }
      return { kind: "boolean" };
    }
    if (expr.op === "lt" || expr.op === "lte") {
      if (args[0]!.kind !== "number" || args[1]!.kind !== "number" || !sameDims(args[0]!.kind === "number" ? args[0]!.dims : {}, args[1]!.kind === "number" ? args[1]!.dims : {})) {
        report(`${path}.args[1]`, `${expr.op} 인자는 같은 차원의 number여야 합니다.`);
      }
      return { kind: "boolean" };
    }
    if (expr.op === "and" || expr.op === "or" || expr.op === "not") {
      args.forEach((arg, index) => {
        if (arg.kind !== "boolean") report(`${path}.args[${index}]`, `${expr.op} 인자는 boolean이어야 합니다.`);
      });
      return { kind: "boolean" };
    }
    const condition = args[0]!;
    if (condition.kind !== "boolean") report(`${path}.args[0]`, "if 조건은 boolean이어야 합니다.");
    if (args[1]!.kind === "list" || args[2]!.kind === "list" || !sameType(args[1]!, args[2]!)) {
      report(`${path}.args[2]`, "if 결과 인자는 같은 타입이어야 합니다.");
      return args[1];
    }
    return args[1];
  };

  function inferComputed(key: string, path: string): StaticType | undefined {
    if (!hasOwn(doc.computed, key)) {
      report(`${path}.computed`, `computed '${key}'를 찾을 수 없습니다.`);
      return undefined;
    }
    if (computedTypes.has(key)) return computedTypes.get(key) ?? undefined;
    if (activeComputed.has(key)) {
      report(path, `computed '${key}'가 순환 참조합니다.`);
      return undefined;
    }
    activeComputed.add(key);
    const type = inferExpr(doc.computed[key]!, `computed.${key}`);
    activeComputed.delete(key);
    if (type?.kind === "list") {
      report(`computed.${key}`, "computed 결과로 list를 사용할 수 없습니다.");
      computedTypes.set(key, null);
      return undefined;
    }
    computedTypes.set(key, type ?? null);
    return type;
  }

  const checkTextPartSemantics = (part: TextPart, path: string): void => {
    if (typeof part === "string") return;
    const refKeys = ["data", "field", "computed"].filter((key) => hasOwn(part.value, key));
    if (refKeys.length !== 1) return;
    const type = typeOfRef(part.value, `${path}.value`);
    if (!type) return;
    const format = part.format ?? (type.kind === "number" ? "number" : "plain");
    if ((format === "number" || format === "percent") && type.kind !== "number") {
      report(`${path}.format`, `${format} 형식은 number에만 사용할 수 있습니다.`);
    }
    if (format === "percent" && type.kind === "number" && Object.keys(type.dims).length !== 0) {
      report(`${path}.format`, "percent 형식은 무차원 number에만 사용할 수 있습니다.");
    }
    if (format === "percent" && hasOwn(part, "unit")) report(`${path}.unit`, "percent 형식에는 unit을 지정할 수 없습니다.");
    if (part.digits !== undefined && type.kind !== "number") report(`${path}.digits`, "digits는 number에만 사용할 수 있습니다.");
    if (part.unit !== undefined) {
      const unit = unitAt(part.unit);
      if (!unit) report(`${path}.unit`, `unit '${part.unit}'를 찾을 수 없습니다.`);
      else if (type.kind !== "number" || !sameDims(type.dims, unit.dims)) report(`${path}.unit`, "unit 차원이 값과 다릅니다.");
    } else if (type.kind === "number" && Object.keys(type.dims).length > 0 && hasOwn(part.value, "computed")) {
      report(`${path}.unit`, "차원이 있는 computed number에는 표시 unit이 필요합니다.");
    }
  };

  const checkParts = (parts: TextPart[], path: string): void => {
    parts.forEach((part, index) => checkTextPartSemantics(part, `${path}[${index}]`));
  };
  const checkActionSemantic = (action: Action, path: string): void => {
    if (action.type === "open_source") {
      if (!hasOwn(doc.sources, action.source)) report(`${path}.source`, `source '${action.source}'를 찾을 수 없습니다.`);
    }
    if (action.type !== "set") {
      if (action.type === "compose" && action.parts) checkParts(action.parts, `${path}.parts`);
      return;
    }
    const field = fieldAt(action.field);
    if (!field) {
      report(`${path}.field`, `field '${action.field}'를 찾을 수 없습니다.`);
      return;
    }
    const value = action.value;
    let valid = false;
    if (field.type === "number") valid = typeof value === "number" && Number.isFinite(value);
    else if (field.type === "text") valid = typeof value === "string";
    else if (field.type === "boolean") valid = typeof value === "boolean";
    else if (field.type === "choice") valid = typeof value === "string" && field.options.some((option) => option.id === value);
    else valid = Array.isArray(value) && value.every((id) => typeof id === "string" && field.options.some((option) => option.id === id)) && new Set(value).size === value.length;
    if (!valid) report(`${path}.value`, `set 값이 field '${action.field}'의 타입이나 선택지와 맞지 않습니다.`);
  };

  const nodeIds = new Set<string>();
  const checkNodeSemantic = (node: Node, path: string): void => {
    if (nodeIds.has(node.id)) report(`${path}.id`, `node id '${node.id}'가 중복됩니다.`);
    nodeIds.add(node.id);
    if (node.visibleWhen) {
      const condition = inferExpr(node.visibleWhen, `${path}.visibleWhen`);
      if (condition && condition.kind !== "boolean") report(`${path}.visibleWhen`, "visibleWhen은 boolean이어야 합니다.");
    }
    if (node.kind === "heading" || node.kind === "text" || node.kind === "caption") checkParts(node.parts, `${path}.parts`);
    else if (node.kind === "group") node.children.forEach((child, index) => checkNodeSemantic(child, `${path}.children[${index}]`));
    else if (node.kind === "slider" || node.kind === "checkbox") {
      const field = fieldAt(node.field);
      if (!field) report(`${path}.field`, `field '${node.field}'를 찾을 수 없습니다.`);
      else if ((node.kind === "slider" && field.type !== "number") || (node.kind === "checkbox" && field.type !== "boolean")) {
        report(`${path}.field`, `${node.kind} field type이 맞지 않습니다.`);
      }
    } else if (node.kind === "form") {
      const formFields = new Set<string>();
      node.items.forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        if (formFields.has(item.field)) report(`${itemPath}.field`, `form field '${item.field}'가 중복됩니다.`);
        formFields.add(item.field);
        if (!fieldAt(item.field)) report(`${itemPath}.field`, `field '${item.field}'를 찾을 수 없습니다.`);
      });
      checkActionSemantic(node.action, `${path}.action`);
    } else if (node.kind === "button") checkActionSemantic(node.action, `${path}.action`);
    else if (node.kind === "entity") {
      checkParts(node.details, `${path}.details`);
      if (node.source && !hasOwn(doc.sources, node.source)) report(`${path}.source`, `source '${node.source}'를 찾을 수 없습니다.`);
    } else if (!hasOwn(doc.sources, node.source)) report(`${path}.source`, `source '${node.source}'를 찾을 수 없습니다.`);
  };

  for (const key of Object.keys(doc.data)) {
    const data = doc.data[key]!;
    if (typeof data.value === "number" && !data.unit) report(`data.${key}.unit`, "숫자 data에는 unit이 필요합니다.");
    if (data.unit && !unitAt(data.unit)) report(`data.${key}.unit`, `unit '${data.unit}'를 찾을 수 없습니다.`);
    if (data.source && !hasOwn(doc.sources, data.source)) report(`data.${key}.source`, `source '${data.source}'를 찾을 수 없습니다.`);
  }
  for (const key of Object.keys(doc.fields)) {
    const field = doc.fields[key]!;
    if (field.type === "number" && !unitAt(field.unit)) report(`fields.${key}.unit`, `unit '${field.unit}'를 찾을 수 없습니다.`);
  }
  for (const key of Object.keys(doc.computed)) inferComputed(key, `computed.${key}`);
  doc.body.forEach((node, index) => checkNodeSemantic(node, `body[${index}]`));

  return issues;
}

export function validateChatUiDocument(input: unknown): ValidationResult {
  let structuralIssues: ValidationIssue[];
  try {
    structuralIssues = checkStructure(input);
  } catch {
    return { ok: false, errors: [{ path: "$", reason: "문서 구조를 안전하게 읽을 수 없습니다." }] };
  }
  if (structuralIssues.length) return { ok: false, errors: structuralIssues.slice(0, MAX_ISSUES) };

  const raw = input as ChatUiDocumentV1;
  const document: NormalizedChatUiDocumentV1 = {
    ...raw,
    body: raw.body,
    units: raw.units ?? {},
    data: raw.data ?? {},
    fields: raw.fields ?? {},
    computed: raw.computed ?? {},
    sources: raw.sources ?? {},
    assumptions: raw.assumptions ?? [],
  };
  const semanticIssues = checkSemantics(document);
  return semanticIssues.length
    ? { ok: false, errors: semanticIssues.slice(0, MAX_ISSUES) }
    : { ok: true, document };
}
