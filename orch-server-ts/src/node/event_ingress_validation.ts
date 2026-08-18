const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EventIngressValidationError extends Error {}

export function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new EventIngressValidationError(`${field} must be an object`);
  return value;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key)).sort();
  if (unexpected.length > 0) {
    throw new EventIngressValidationError(
      `${field} has unexpected fields: ${unexpected.join(", ")}`,
    );
  }
}

export function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new EventIngressValidationError(`${field} must be ISO-8601`);
  }
  return text;
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new EventIngressValidationError(`${field} must be string`);
  return value;
}

export function requiredUuid(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!UUID_PATTERN.test(text)) throw new EventIngressValidationError(`${field} must be UUID`);
  return text;
}

export function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EventIngressValidationError(`${field} must be a positive integer`);
  }
  return value as number;
}

export function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return positiveInteger(value, field);
}

export function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new EventIngressValidationError(`${field} must be boolean`);
  }
  return value;
}

export function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EventIngressValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

export function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new EventIngressValidationError(`${field} must be string|null`);
  return value;
}

export function nullableNonEmptyString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, field);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
