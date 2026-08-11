import { z } from "zod";

interface JsonContractFailure {
  path: PropertyKey[];
  message: string;
}

function findJsonContractFailure(
  value: unknown,
  path: PropertyKey[] = [],
  seen: WeakSet<object> = new WeakSet(),
): JsonContractFailure | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : { path, message: "JSON numbers must be finite" };
  }
  if (typeof value !== "object") {
    return { path, message: `${typeof value} is not a JSON value` };
  }
  if (seen.has(value)) {
    return { path, message: "Repeated or cyclic object references are not JSON values" };
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const expectedKeys = new Set(Array.from({ length: value.length }, (_, index) => String(index)));
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !expectedKeys.has(key)) {
        return { path: [...path, key], message: "Array properties must be JSON indices" };
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return { path: [...path, index], message: "Sparse arrays are not JSON values" };
      }
      const failure = findJsonContractFailure(value[index], [...path, index], seen);
      if (failure) return failure;
    }
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { path, message: "JSON objects must be plain objects" };
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return { path: [...path, key], message: "JSON objects cannot have Symbol keys" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      return { path: [...path, key], message: "JSON object fields must be enumerable" };
    }
    if (!("value" in descriptor)) {
      return { path: [...path, key], message: "JSON object fields cannot be accessors" };
    }
    const failure = findJsonContractFailure(descriptor.value, [...path, key], seen);
    if (failure) return failure;
  }
  return null;
}

export function assertRunnerJsonValue(value: unknown, context = "runner JSON value"): void {
  const failure = findJsonContractFailure(value);
  if (!failure) return;
  const path = failure.path.length === 0
    ? "$"
    : `$${failure.path.map((part) => typeof part === "number"
      ? `[${part}]`
      : `.${String(part)}`).join("")}`;
  throw new Error(`${context} violates JSON contract at ${path}: ${failure.message}`);
}

/**
 * Match JSON.stringify only for undefined: object fields are omitted and array
 * slots become null. Every other non-JSON value is deliberately preserved so
 * the strict contract can reject it instead of silently losing information.
 */
export function stripRunnerJsonUndefined(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  return stripUndefined(value, false, seen);
}

function stripUndefined(
  value: unknown,
  arraySlot: boolean,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === undefined) return arraySlot ? null : undefined;
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return value;
      output.push(stripUndefined(value[index], true, seen));
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length" || (typeof key === "string" && /^\d+$/.test(key))) continue;
      return value;
    }
    return output;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const output = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, output);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return value;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return value;
    if (descriptor.value === undefined) continue;
    output[key] = stripUndefined(descriptor.value, false, seen);
  }
  return output;
}

export function withRunnerJsonContract<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, ctx) => {
    const failure = findJsonContractFailure(value);
    if (failure) {
      ctx.addIssue({ code: "custom", path: failure.path, message: failure.message });
    }
    return value;
  }, schema);
}
