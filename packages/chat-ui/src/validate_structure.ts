import { CHAT_UI_LIMITS } from "./types.js";
import type { ValidationIssue } from "./types.js";
import {
  addIssue,
  codePointLength,
  hasOwn,
  inspectJsonValue,
  isPlainObject,
  MAX_ISSUES,
  utf8ByteLength,
} from "./validate_utils.js";
import type { UnknownRecord } from "./validate_utils.js";

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const DIMENSION_PATTERN = /^[A-Za-z][A-Za-z0-9_:]{0,31}$/;

function checkObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: ValidationIssue[],
): UnknownRecord | undefined {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "객체가 필요합니다.");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addIssue(issues, path ? `${path}.${key}` : key, "알 수 없는 키입니다.");
    if (issues.length >= MAX_ISSUES) return value;
  }
  for (const key of required) {
    if (!hasOwn(value, key)) addIssue(issues, path ? `${path}.${key}` : key, "필수 값입니다.");
    if (issues.length >= MAX_ISSUES) return value;
  }
  return value;
}

function checkArray(value: unknown, path: string, issues: ValidationIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "배열이 필요합니다.");
    return undefined;
  }
  return value;
}

function checkString(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string") addIssue(issues, path, "문자열이 필요합니다.");
}

function checkFiniteNumber(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addIssue(issues, path, "유한한 수가 필요합니다.");
  }
}

function checkKey(value: unknown, path: string, issues: ValidationIssue[]): void {
  const match = typeof value === "string" ? KEY_PATTERN.exec(value) : undefined;
  if (!match || match[0] !== value) {
    addIssue(issues, path, "키는 영문자로 시작하고 영문자, 숫자, 밑줄만 써야 합니다.");
  }
}

function checkScalar(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === "number") checkFiniteNumber(value, path, issues);
  else if (typeof value !== "string" && typeof value !== "boolean") {
    addIssue(issues, path, "문자열, 불리언, 유한한 수만 사용할 수 있습니다.");
  }
}

function checkValueRef(value: unknown, path: string, issues: ValidationIssue[]): void {
  const object = checkObject(value, path, ["data", "field", "computed"], [], issues);
  if (!object) return;
  const keys = ["data", "field", "computed"].filter((key) => hasOwn(object, key));
  if (keys.length !== 1) addIssue(issues, path, "data, field, computed 중 하나만 지정해야 합니다.");
  for (const key of keys) checkKey(object[key], `${path}.${key}`, issues);
}

function checkTextPart(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value === "string") return;
  const object = checkObject(value, path, ["value", "format", "digits", "unit"], ["value"], issues);
  if (!object) return;
  checkValueRef(object.value, `${path}.value`, issues);
  if (hasOwn(object, "format") && object.format !== "plain" && object.format !== "number" && object.format !== "percent") {
    addIssue(issues, `${path}.format`, "지원하는 표시 형식이 아닙니다.");
  }
  if (hasOwn(object, "digits")) {
    checkFiniteNumber(object.digits, `${path}.digits`, issues);
    if (typeof object.digits === "number" && (!Number.isInteger(object.digits) || object.digits < 0 || object.digits > 6)) {
      addIssue(issues, `${path}.digits`, "digits는 0에서 6 사이의 정수여야 합니다.");
    }
  }
  if (hasOwn(object, "unit")) checkKey(object.unit, `${path}.unit`, issues);
}

function checkTextParts(value: unknown, path: string, issues: ValidationIssue[]): void {
  const parts = checkArray(value, path, issues);
  if (!parts) return;
  parts.forEach((part, index) => checkTextPart(part, `${path}[${index}]`, issues));
}

function checkOption(value: unknown, path: string, issues: ValidationIssue[]): void {
  const option = checkObject(value, path, ["id", "label"], ["id", "label"], issues);
  if (!option) return;
  checkKey(option.id, `${path}.id`, issues);
  checkString(option.label, `${path}.label`, issues);
}

function checkField(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    addIssue(issues, path, "필드 객체와 type이 필요합니다.");
    return;
  }
  if (value.type === "number") {
    const field = checkObject(value, path, ["type", "initial", "min", "max", "step", "unit"], ["type", "initial", "min", "max", "step", "unit"], issues);
    if (!field) return;
    for (const key of ["initial", "min", "max", "step"]) checkFiniteNumber(field[key], `${path}.${key}`, issues);
    checkKey(field.unit, `${path}.unit`, issues);
    if ([field.initial, field.min, field.max, field.step].every((part) => typeof part === "number" && Number.isFinite(part))) {
      if ((field.min as number) >= (field.max as number)) addIssue(issues, `${path}.min`, "min은 max보다 작아야 합니다.");
      if ((field.step as number) <= 0) addIssue(issues, `${path}.step`, "step은 0보다 커야 합니다.");
      if ((field.initial as number) < (field.min as number) || (field.initial as number) > (field.max as number)) {
        addIssue(issues, `${path}.initial`, "initial은 min과 max 사이여야 합니다.");
      }
    }
    return;
  }
  if (value.type === "text") {
    const field = checkObject(value, path, ["type", "initial", "maxLength"], ["type", "initial", "maxLength"], issues);
    if (!field) return;
    checkString(field.initial, `${path}.initial`, issues);
    checkFiniteNumber(field.maxLength, `${path}.maxLength`, issues);
    if (typeof field.maxLength === "number" && (!Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 2000)) {
      addIssue(issues, `${path}.maxLength`, "maxLength는 1에서 2000 사이의 정수여야 합니다.");
    }
    if (typeof field.initial === "string" && typeof field.maxLength === "number" && codePointLength(field.initial) > field.maxLength) {
      addIssue(issues, `${path}.initial`, "initial이 maxLength를 넘습니다.");
    }
    return;
  }
  if (value.type === "boolean") {
    const field = checkObject(value, path, ["type", "initial"], ["type", "initial"], issues);
    if (field && typeof field.initial !== "boolean") addIssue(issues, `${path}.initial`, "불리언 값이 필요합니다.");
    return;
  }
  if (value.type === "choice" || value.type === "selection") {
    const field = checkObject(value, path, ["type", "initial", "options"], ["type", "initial", "options"], issues);
    if (!field) return;
    const options = checkArray(field.options, `${path}.options`, issues);
    if (options) {
      if (options.length < 1) addIssue(issues, `${path}.options`, "options는 하나 이상이어야 합니다.");
      const ids = new Set<string>();
      options.forEach((option, index) => {
        const optionPath = `${path}.options[${index}]`;
        checkOption(option, optionPath, issues);
        if (isPlainObject(option) && typeof option.id === "string") {
          if (ids.has(option.id)) addIssue(issues, `${optionPath}.id`, "option id는 서로 달라야 합니다.");
          ids.add(option.id);
        }
      });
      const validIds = new Set(options.filter(isPlainObject).map((option) => option.id).filter((id): id is string => typeof id === "string"));
      if (value.type === "choice") {
        checkKey(field.initial, `${path}.initial`, issues);
        if (typeof field.initial === "string" && !validIds.has(field.initial)) addIssue(issues, `${path}.initial`, "initial은 options의 id여야 합니다.");
      } else {
        const initial = checkArray(field.initial, `${path}.initial`, issues);
        if (initial) {
          const selected = new Set<string>();
          initial.forEach((id, index) => {
            checkKey(id, `${path}.initial[${index}]`, issues);
            if (typeof id === "string") {
              if (!validIds.has(id)) addIssue(issues, `${path}.initial[${index}]`, "initial은 options의 id여야 합니다.");
              if (selected.has(id)) addIssue(issues, `${path}.initial[${index}]`, "initial에는 중복 선택을 둘 수 없습니다.");
              selected.add(id);
            }
          });
        }
      }
    }
    return;
  }
  addIssue(issues, `${path}.type`, "지원하지 않는 필드 type입니다.");
}

function checkUnit(value: unknown, path: string, issues: ValidationIssue[]): void {
  const object = checkObject(value, path, ["dims", "symbol", "scale"], ["dims", "symbol", "scale"], issues);
  if (!object) return;
  const dims = checkObject(object.dims, `${path}.dims`, Object.keys(isPlainObject(object.dims) ? object.dims : {}), [], issues);
  if (dims) {
    const keys = Object.keys(dims);
    if (keys.length > 4) addIssue(issues, `${path}.dims`, "차원 키는 네 개 이하여야 합니다.");
    for (const key of keys) {
      const exponent = dims[key];
      if (!DIMENSION_PATTERN.test(key)) addIssue(issues, `${path}.dims.${key}`, "차원 키 형식이 올바르지 않습니다.");
      checkFiniteNumber(exponent, `${path}.dims.${key}`, issues);
      if (typeof exponent === "number" && (!Number.isInteger(exponent) || exponent < -3 || exponent > 3 || exponent === 0)) {
        addIssue(issues, `${path}.dims.${key}`, "차원 지수는 -3에서 3 사이의 0이 아닌 정수여야 합니다.");
      }
    }
  }
  checkString(object.symbol, `${path}.symbol`, issues);
  if (typeof object.symbol === "string" && codePointLength(object.symbol) > 12) addIssue(issues, `${path}.symbol`, "symbol은 12자 이하여야 합니다.");
  checkFiniteNumber(object.scale, `${path}.scale`, issues);
  if (typeof object.scale === "number" && object.scale <= 0) addIssue(issues, `${path}.scale`, "scale은 0보다 커야 합니다.");
}

function checkDataValue(value: unknown, path: string, issues: ValidationIssue[]): void {
  const object = checkObject(value, path, ["value", "unit", "source"], ["value"], issues);
  if (!object) return;
  checkScalar(object.value, `${path}.value`, issues);
  if (hasOwn(object, "unit")) checkKey(object.unit, `${path}.unit`, issues);
  if (hasOwn(object, "source")) checkKey(object.source, `${path}.source`, issues);
}

function checkSource(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    addIssue(issues, path, "출처 객체와 type이 필요합니다.");
    return;
  }
  if (value.type === "assumption") {
    const source = checkObject(value, path, ["type", "label", "note"], ["type", "label"], issues);
    if (!source) return;
    checkString(source.label, `${path}.label`, issues);
    if (hasOwn(source, "note")) checkString(source.note, `${path}.note`, issues);
    return;
  }
  if (value.type === "external_link") {
    const source = checkObject(value, path, ["type", "label", "url"], ["type", "label", "url"], issues);
    if (!source) return;
    checkString(source.label, `${path}.label`, issues);
    checkString(source.url, `${path}.url`, issues);
    if (typeof source.url === "string" && (!source.url.startsWith("https://") || codePointLength(source.url) > 2000)) {
      addIssue(issues, `${path}.url`, "url은 2000자 이하의 https 주소여야 합니다.");
    }
    return;
  }
  addIssue(issues, `${path}.type`, "지원하지 않는 source type입니다.");
}

function checkAction(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    addIssue(issues, path, "action 객체와 type이 필요합니다.");
    return;
  }
  if (value.type === "set") {
    const action = checkObject(value, path, ["type", "field", "value"], ["type", "field", "value"], issues);
    if (!action) return;
    checkKey(action.field, `${path}.field`, issues);
    if (Array.isArray(action.value)) action.value.forEach((part, index) => checkString(part, `${path}.value[${index}]`, issues));
    else if (typeof action.value !== "number" && typeof action.value !== "string" && typeof action.value !== "boolean") {
      addIssue(issues, `${path}.value`, "FieldValue가 필요합니다.");
    } else if (typeof action.value === "number") checkFiniteNumber(action.value, `${path}.value`, issues);
    return;
  }
  if (value.type === "reset" || value.type === "copy") {
    checkObject(value, path, ["type"], ["type"], issues);
    return;
  }
  if (value.type === "open_source") {
    const action = checkObject(value, path, ["type", "source"], ["type", "source"], issues);
    if (action) checkKey(action.source, `${path}.source`, issues);
    return;
  }
  if (value.type === "compose") {
    const action = checkObject(value, path, ["type", "parts"], ["type"], issues);
    if (action && hasOwn(action, "parts")) checkTextParts(action.parts, `${path}.parts`, issues);
    return;
  }
  addIssue(issues, `${path}.type`, "지원하지 않는 action type입니다.");
}

function checkExpr(value: unknown, path: string, depth: number, issues: ValidationIssue[]): void {
  if (depth > CHAT_UI_LIMITS.maxExprDepth) {
    addIssue(issues, path, "식 중첩이 허용 깊이를 넘습니다.");
    return;
  }
  if (!isPlainObject(value) || typeof value.op !== "string") {
    addIssue(issues, path, "식 객체와 op가 필요합니다.");
    return;
  }
  const op = value.op;
  if (op === "const") {
    const expr = checkObject(value, path, ["op", "value", "unit"], ["op", "value"], issues);
    if (!expr) return;
    checkScalar(expr.value, `${path}.value`, issues);
    if (hasOwn(expr, "unit")) checkKey(expr.unit, `${path}.unit`, issues);
    return;
  }
  if (op === "ref") {
    const expr = checkObject(value, path, ["op", "ref"], ["op", "ref"], issues);
    if (expr) checkValueRef(expr.ref, `${path}.ref`, issues);
    return;
  }
  const arities: Record<string, number | "many"> = {
    add: "many", sub: 2, mul: "many", div: 2, eq: 2, lt: 2, lte: 2,
    and: "many", or: "many", not: 1, if: 3,
  };
  if (!hasOwn(arities, op)) {
    checkObject(value, path, ["op"], ["op"], issues);
    addIssue(issues, `${path}.op`, "지원하지 않는 op입니다.");
    return;
  }
  const arity = arities[op]!;
  const expr = checkObject(value, path, ["op", "args"], ["op", "args"], issues);
  if (!expr) return;
  const args = checkArray(expr.args, `${path}.args`, issues);
  if (!args) return;
  const minimum = arity === "many" ? 2 : arity;
  if (args.length < minimum || (arity !== "many" && args.length !== arity)) {
    addIssue(issues, `${path}.args`, `이 op에는 ${minimum}개의 인자가 필요합니다.`);
  }
  args.forEach((arg, index) => checkExpr(arg, `${path}.args[${index}]`, depth + 1, issues));
}

function checkNode(value: unknown, path: string, depth: number, count: { nodes: number }, issues: ValidationIssue[]): void {
  if (depth > CHAT_UI_LIMITS.maxNodeDepth) {
    addIssue(issues, path, "노드 중첩이 허용 깊이를 넘습니다.");
    return;
  }
  count.nodes += 1;
  if (count.nodes > CHAT_UI_LIMITS.maxNodes) {
    addIssue(issues, path, "노드 수가 허용 상한을 넘습니다.");
    return;
  }
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    addIssue(issues, path, "노드 객체와 kind가 필요합니다.");
    return;
  }
  const base = ["id", "visibleWhen"];
  const kind = value.kind;
  const fields: Record<string, { allowed: string[]; required: string[] }> = {
    heading: { allowed: ["level", "parts"], required: ["level", "parts"] },
    text: { allowed: ["parts", "emphasis"], required: ["parts"] },
    caption: { allowed: ["parts"], required: ["parts"] },
    group: { allowed: ["layout", "children"], required: ["layout", "children"] },
    slider: { allowed: ["field", "label"], required: ["field", "label"] },
    checkbox: { allowed: ["field", "label"], required: ["field", "label"] },
    form: { allowed: ["items", "submitLabel", "action"], required: ["items", "submitLabel", "action"] },
    button: { allowed: ["label", "action"], required: ["label", "action"] },
    entity: { allowed: ["label", "details", "source"], required: ["label", "details"] },
    citation: { allowed: ["source"], required: ["source"] },
  };
  if (!hasOwn(fields, kind)) {
    checkObject(value, path, [...base, "kind"], ["id", "kind"], issues);
    addIssue(issues, `${path}.kind`, "지원하지 않는 kind입니다.");
    return;
  }
  const spec = fields[kind]!;
  const allowed = [...base, "kind", ...spec.allowed];
  const required = ["id", "kind", ...spec.required];
  const node = checkObject(value, path, allowed, required, issues);
  if (!node) return;
  checkKey(node.id, `${path}.id`, issues);
  if (hasOwn(node, "visibleWhen")) checkExpr(node.visibleWhen, `${path}.visibleWhen`, 1, issues);

  if (kind === "heading") {
    if (node.level !== 1 && node.level !== 2 && node.level !== 3) addIssue(issues, `${path}.level`, "heading level은 1, 2, 3 중 하나여야 합니다.");
    checkTextParts(node.parts, `${path}.parts`, issues);
  } else if (kind === "text") {
    checkTextParts(node.parts, `${path}.parts`, issues);
    if (hasOwn(node, "emphasis") && node.emphasis !== "strong") addIssue(issues, `${path}.emphasis`, "지원하지 않는 emphasis입니다.");
  } else if (kind === "caption") checkTextParts(node.parts, `${path}.parts`, issues);
  else if (kind === "group") {
    if (node.layout !== "stack" && node.layout !== "row" && node.layout !== "wrap") addIssue(issues, `${path}.layout`, "지원하지 않는 group layout입니다.");
    const children = checkArray(node.children, `${path}.children`, issues);
    children?.forEach((child, index) => checkNode(child, `${path}.children[${index}]`, depth + 1, count, issues));
  } else if (kind === "slider" || kind === "checkbox") {
    checkKey(node.field, `${path}.field`, issues);
    checkString(node.label, `${path}.label`, issues);
  } else if (kind === "form") {
    const items = checkArray(node.items, `${path}.items`, issues);
    items?.forEach((item, index) => {
      const itemPath = `${path}.items[${index}]`;
      const formItem = checkObject(item, itemPath, ["field", "label"], ["field", "label"], issues);
      if (formItem) {
        checkKey(formItem.field, `${itemPath}.field`, issues);
        checkString(formItem.label, `${itemPath}.label`, issues);
      }
    });
    checkString(node.submitLabel, `${path}.submitLabel`, issues);
    if (isPlainObject(node.action) && node.action.type !== "compose") {
      addIssue(issues, `${path}.action.type`, "form action은 compose여야 합니다.");
    }
    checkAction(node.action, `${path}.action`, issues);
  } else if (kind === "button") {
    checkString(node.label, `${path}.label`, issues);
    checkAction(node.action, `${path}.action`, issues);
  } else if (kind === "entity") {
    checkString(node.label, `${path}.label`, issues);
    checkTextParts(node.details, `${path}.details`, issues);
    if (hasOwn(node, "source")) checkKey(node.source, `${path}.source`, issues);
  } else if (kind === "citation") checkKey(node.source, `${path}.source`, issues);
}

function checkMap(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  checkEntry: (entry: unknown, entryPath: string, issues: ValidationIssue[]) => void,
): void {
  const map = checkObject(value, path, isPlainObject(value) ? Object.keys(value) : [], [], issues);
  if (!map) return;
  for (const key of Object.keys(map)) {
    checkKey(key, `${path}.${key}`, issues);
    checkEntry(map[key], `${path}.${key}`, issues);
    if (issues.length >= MAX_ISSUES) return;
  }
}

export function checkStructure(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxJsonDepth = 2 * CHAT_UI_LIMITS.maxNodeDepth + 2 * CHAT_UI_LIMITS.maxExprDepth + 8;
  inspectJsonValue(input, "", issues, new WeakSet(), 0, maxJsonDepth);
  if (issues.length) return issues;

  const root = checkObject(
    input,
    "",
    ["schema_version", "title", "body", "units", "data", "fields", "computed", "sources", "assumptions"],
    ["schema_version", "body"],
    issues,
  );
  if (!root) return issues;
  if (root.schema_version !== 1) addIssue(issues, "schema_version", "schema_version은 1이어야 합니다.");
  if (hasOwn(root, "title")) checkString(root.title, "title", issues);
  const nodes = checkArray(root.body, "body", issues);
  const nodeCount = { nodes: 0 };
  nodes?.forEach((node, index) => checkNode(node, `body[${index}]`, 1, nodeCount, issues));
  if (hasOwn(root, "units")) checkMap(root.units, "units", issues, checkUnit);
  if (hasOwn(root, "data")) checkMap(root.data, "data", issues, checkDataValue);
  if (hasOwn(root, "fields")) checkMap(root.fields, "fields", issues, checkField);
  if (hasOwn(root, "computed")) {
    checkMap(root.computed, "computed", issues, (value, path, list) => checkExpr(value, path, 1, list));
    if (isPlainObject(root.computed) && Object.keys(root.computed).length > CHAT_UI_LIMITS.maxComputed) {
      addIssue(issues, "computed", "computed 수가 허용 상한을 넘습니다.");
    }
  }
  if (hasOwn(root, "sources")) checkMap(root.sources, "sources", issues, checkSource);
  if (hasOwn(root, "assumptions")) {
    const assumptions = checkArray(root.assumptions, "assumptions", issues);
    assumptions?.forEach((value, index) => checkString(value, `assumptions[${index}]`, issues));
  }
  if (issues.length) return issues;

  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined || utf8ByteLength(serialized) > CHAT_UI_LIMITS.maxDocumentBytes) {
      addIssue(issues, "$", "문서가 최대 UTF-8 크기를 넘습니다.");
    }
  } catch {
    addIssue(issues, "$", "문서를 JSON으로 직렬화할 수 없습니다.");
  }
  return issues;
}
