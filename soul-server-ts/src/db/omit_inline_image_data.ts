const OMITTED_IMAGE = "[omitted image]";
const JSON_IMAGE_DATA = /"type"\s*:\s*"image"[^}]{0,160}?"data"\s*:\s*"([A-Za-z0-9+/=]{64,})/g;
const IMAGE_DATA_URL = /data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=]{64,})/g;

export function omitInlineImageData<T>(payload: T): T {
  return transformValue(payload) as T;
}

function transformValue(value: unknown): unknown {
  if (typeof value === "string") {
    return omitImageBytesFromString(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const transformed = transformValue(item);
      changed ||= transformed !== item;
      return transformed;
    });
    return changed ? items : value;
  }
  if (!isRecord(value)) return value;

  const isImage = value.type === "image";
  const source = isImage && isRecord(value.source) ? value.source : null;
  const omitSourceData = source?.type === "base64"
    && typeof source.data === "string"
    && source.data !== OMITTED_IMAGE;
  const omitImageData = isImage
    && typeof value.data === "string"
    && value.data !== OMITTED_IMAGE;
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    let transformed: unknown;
    if (key === "source" && omitSourceData && source) {
      transformed = Object.fromEntries(Object.entries(source).map(([sourceKey, sourceValue]) => [
        sourceKey,
        sourceKey === "data" ? OMITTED_IMAGE : transformValue(sourceValue),
      ]));
    } else if (key === "data" && omitImageData) {
      transformed = OMITTED_IMAGE;
    } else {
      transformed = transformValue(item);
    }
    changed ||= transformed !== item;
    return [key, transformed] as const;
  });
  return changed ? Object.fromEntries(entries) : value;
}

function omitImageBytesFromString(value: string): string {
  return value
    .replace(JSON_IMAGE_DATA, (match, data: string) => match.replace(data, OMITTED_IMAGE))
    .replace(IMAGE_DATA_URL, (match, data: string) => (
      `${match.slice(0, match.length - data.length)}${OMITTED_IMAGE}`
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
