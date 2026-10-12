import type { ValidationIssue } from "./types.js";

export type UnknownRecord = Record<string, unknown>;
export const MAX_ISSUES = 20;
export const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
export const codePointLength = (value: string): number => [...value].length;
export function addIssue(issues: ValidationIssue[], path: string, reason: string): void {
  if (issues.length < MAX_ISSUES) issues.push({ path: path || "$", reason });
}

export function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function inspectJsonValue(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  seen: WeakSet<object>,
): void {
  if (issues.length >= MAX_ISSUES) return;
  if (value === null || value === undefined) {
    addIssue(issues, path, "null과 undefined는 사용할 수 없습니다.");
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) addIssue(issues, path, "유한한 수만 사용할 수 있습니다.");
    return;
  }
  if (typeof value !== "object") {
    addIssue(issues, path, "JSON 값만 사용할 수 있습니다.");
    return;
  }
  if (seen.has(value)) {
    addIssue(issues, path, "순환하거나 공유된 객체 참조는 사용할 수 없습니다.");
    return;
  }
  seen.add(value);

  const array = Array.isArray(value);
  if (array) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      addIssue(issues, path, "일반 배열만 사용할 수 있습니다.");
      return;
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (keys.some((key) => typeof key !== "string") || keys.length !== value.length) {
      addIssue(issues, path, "빈 칸이나 추가 속성이 없는 배열만 사용할 수 있습니다.");
      return;
    }
    for (let index = 0; index < value.length && issues.length < MAX_ISSUES; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        addIssue(issues, `${path}[${index}]`, "열거 가능한 일반 데이터 속성만 사용할 수 있습니다.");
        continue;
      }
      inspectJsonValue(descriptor.value, `${path}[${index}]`, issues, seen);
    }
    return;
  }

  if (!isPlainObject(value)) {
    addIssue(issues, path, "일반 객체만 사용할 수 있습니다.");
    return;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string") {
      addIssue(issues, path, "문자열 키만 사용할 수 있습니다.");
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      addIssue(issues, path ? `${path}.${key}` : key, "열거 가능한 일반 데이터 속성만 사용할 수 있습니다.");
      continue;
    }
    inspectJsonValue(
      descriptor.value,
      path ? `${path}.${key}` : key,
      issues,
      seen,
    );
    if (issues.length >= MAX_ISSUES) return;
  }
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
