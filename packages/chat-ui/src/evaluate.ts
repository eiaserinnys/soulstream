import type {
  ChatUiState,
  Expr,
  FieldValue,
  NormalizedChatUiDocumentV1,
  Value,
  ValueRef,
} from "./types.js";

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function error(code: "DIV_BY_ZERO" | "OUT_OF_RANGE"): Value {
  return code === "DIV_BY_ZERO"
    ? { type: "error", code, message: "0으로 나눌 수 없습니다" }
    : { type: "error", code, message: "값이 표현 범위를 벗어났습니다" };
}

function numberValue(base: number, dims: Record<string, number>): Value {
  if (!Number.isFinite(base) || Math.abs(base) > Number.MAX_SAFE_INTEGER) return error("OUT_OF_RANGE");
  return { type: "number", base, dims };
}

function dimsForProduct(values: Value[], divideBy?: Value): Record<string, number> {
  const dims: Record<string, number> = {};
  for (const value of values) {
    if (value.type !== "number") continue;
    for (const key of Object.keys(value.dims)) {
      dims[key] = (hasOwn(dims, key) ? dims[key]! : 0) + value.dims[key]!;
    }
  }
  if (divideBy?.type === "number") {
    for (const key of Object.keys(divideBy.dims)) {
      dims[key] = (hasOwn(dims, key) ? dims[key]! : 0) - divideBy.dims[key]!;
    }
  }
  for (const key of Object.keys(dims)) if (dims[key] === 0) delete dims[key];
  return Object.fromEntries(Object.keys(dims).sort().map((key) => [key, dims[key]!])) as Record<string, number>;
}

function fieldValue(state: ChatUiState, field: string): FieldValue {
  return state.values[field]!;
}

type EvaluationContext = {
  computed: Record<string, Value>;
  evaluateExpression: (expr: Expr) => Value;
};

export function createEvaluationContext(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
): EvaluationContext {
  const computedValues = Object.create(null) as Record<string, Value>;
  const active = new Set<string>();

  const evalRef = (ref: ValueRef): Value => {
    if ("data" in ref) {
      const data = doc.data[ref.data]!;
      if (typeof data.value === "number") {
        const unit = doc.units[data.unit!]!;
        return numberValue(data.value * unit.scale, unit.dims);
      }
      return typeof data.value === "string"
        ? { type: "string", value: data.value }
        : { type: "boolean", value: data.value };
    }
    if ("field" in ref) {
      const key = ref.field;
      const field = doc.fields[key]!;
      const value = fieldValue(state, key);
      if (field.type === "number") {
        const unit = doc.units[field.unit]!;
        return numberValue((value as number) * unit.scale, unit.dims);
      }
      if (field.type === "text") return { type: "string", value: value as string };
      if (field.type === "boolean") return { type: "boolean", value: value as boolean };
      return field.type === "choice"
        ? { type: "string", value: value as string }
        : { type: "list", value: [...(value as string[])] };
    }
    return evalComputed((ref as { computed: string }).computed);
  };

  const evalExpr = (expr: Expr): Value => {
    if (expr.op === "const") {
      if (typeof expr.value !== "number") {
        return typeof expr.value === "string"
          ? { type: "string", value: expr.value }
          : { type: "boolean", value: expr.value };
      }
      const unit = doc.units[expr.unit!]!;
      return numberValue(expr.value * unit.scale, unit.dims);
    }
    if (expr.op === "ref") return evalRef(expr.ref);
    if (expr.op === "if") {
      const condition = evalExpr(expr.args[0]);
      if (condition.type === "error") return condition;
      return evalExpr((condition as Extract<Value, { type: "boolean" }>).value ? expr.args[1] : expr.args[2]);
    }

    const values = expr.args.map(evalExpr);
    const firstError = values.find((value) => value.type === "error");
    if (firstError) return firstError;

    if (expr.op === "add" || expr.op === "sub") {
      const numbers = values as Array<Extract<Value, { type: "number" }>>;
      const first = numbers[0]!;
      const base = expr.op === "add"
        ? numbers.reduce((sum, value) => sum + value.base, 0)
        : first.base - numbers[1]!.base;
      return numberValue(base, first.dims);
    }
    if (expr.op === "mul" || expr.op === "div") {
      const numbers = values as Array<Extract<Value, { type: "number" }>>;
      const first = numbers[0]!;
      if (expr.op === "div" && numbers[1]!.base === 0) return error("DIV_BY_ZERO");
      const base = expr.op === "mul"
        ? numbers.reduce((product, value) => product * value.base, 1)
        : first.base / numbers[1]!.base;
      return numberValue(base, expr.op === "div" ? dimsForProduct([first], numbers[1]!) : dimsForProduct(numbers));
    }
    if (expr.op === "eq") {
      const left = values[0]!;
      const right = values[1]!;
      const equal = left.type === "number" && right.type === "number"
        ? left.base === right.base
        : left.type === "string" && right.type === "string"
          ? left.value === right.value
          : left.type === "boolean" && right.type === "boolean"
            ? left.value === right.value
            : false;
      return { type: "boolean", value: equal };
    }
    if (expr.op === "lt" || expr.op === "lte") {
      const left = (values[0] as Extract<Value, { type: "number" }>).base;
      const right = (values[1] as Extract<Value, { type: "number" }>).base;
      return { type: "boolean", value: expr.op === "lt" ? left < right : left <= right };
    }
    if (expr.op === "and" || expr.op === "or") {
      const booleans = values as Array<Extract<Value, { type: "boolean" }>>;
      return {
        type: "boolean",
        value: expr.op === "and" ? booleans.every((value) => value.value) : booleans.some((value) => value.value),
      };
    }
    const value = values[0] as Extract<Value, { type: "boolean" }>;
    return { type: "boolean", value: !value.value };
  };

  function evalComputed(key: string): Value {
    if (hasOwn(computedValues, key)) return computedValues[key]!;
    if (active.has(key)) return error("OUT_OF_RANGE");
    active.add(key);
    const result = evalExpr(doc.computed[key]!);
    active.delete(key);
    computedValues[key] = result;
    return result;
  }

  for (const key of Object.keys(doc.computed)) evalComputed(key);
  return { computed: computedValues, evaluateExpression: evalExpr };
}

export function evaluate(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
): { computed: Record<string, Value> } {
  return { computed: createEvaluationContext(doc, state).computed };
}
