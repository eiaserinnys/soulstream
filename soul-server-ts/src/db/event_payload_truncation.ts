export const EVENT_STRING_MAX_BYTES = 256 * 1024;
export const EVENT_TRUNCATION_SUFFIX = "\n[잘림]";

export interface TruncatedEventField {
  path: (string | number)[];
  original: string;
}

export interface EventArchiveContent {
  body: string;
  mimeType: "text/plain" | "application/json";
  extension: "txt" | "json";
}

export function truncateEventStrings<T>(payload: T): {
  payload: T;
  truncatedFields: TruncatedEventField[];
} {
  const truncatedFields: TruncatedEventField[] = [];
  const value = truncateValue(payload, [], truncatedFields);
  return { payload: value as T, truncatedFields };
}

function truncateValue(
  value: unknown,
  path: (string | number)[],
  truncatedFields: TruncatedEventField[],
): unknown {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= EVENT_STRING_MAX_BYTES) return value;
    truncatedFields.push({ path, original: value });
    return truncateString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      truncateValue(item, [...path, index], truncatedFields),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      truncateValue(item, [...path, key], truncatedFields),
    ]));
  }
  return value;
}

function truncateString(value: string): string {
  const suffixBytes = Buffer.byteLength(EVENT_TRUNCATION_SUFFIX, "utf8");
  const prefixByteLimit = EVENT_STRING_MAX_BYTES - suffixBytes;
  let prefixBytes = 0;
  let index = 0;

  while (index < value.length) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    let codePoint = first;
    let codeUnits = 1;
    if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
      codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      codeUnits = 2;
    }
    const codePointBytes = codePoint <= 0x7f ? 1
      : codePoint <= 0x7ff ? 2
      : codePoint <= 0xffff ? 3
      : 4;
    if (prefixBytes + codePointBytes > prefixByteLimit) break;
    prefixBytes += codePointBytes;
    index += codeUnits;
  }

  return `${value.slice(0, index)}${EVENT_TRUNCATION_SUFFIX}`;
}

export function buildEventArchive(
  truncatedFields: readonly TruncatedEventField[],
): EventArchiveContent | null {
  if (truncatedFields.length === 0) return null;
  if (truncatedFields.length === 1) {
    return {
      body: truncatedFields[0]!.original,
      mimeType: "text/plain",
      extension: "txt",
    };
  }
  const entries = truncatedFields.map(({ path, original }) => [path.join("."), original]);
  return {
    body: JSON.stringify(Object.fromEntries(entries)),
    mimeType: "application/json",
    extension: "json",
  };
}
