/**
 * PostgreSQL은 text/json 값에 NUL(U+0000)을 저장하지 못하고(22P05/22021),
 * lone surrogate는 UTF-8 인코딩 단계에서 깨진다. 노드가 보낸 이벤트가 이런
 * 문자를 품고 있으면 event_append가 영구 실패해 ingress가 무한 재시도에
 * 빠지므로, ingress 파싱 경계에서 방어적으로 정화한다.
 */

const NUL = /\u0000/g;

export function sanitizePgText(value: string): string {
  let cleaned = value.replace(NUL, "");
  if (!hasLoneSurrogate(cleaned)) return cleaned;

  let result = "";
  for (let index = 0; index < cleaned.length; index += 1) {
    const code = cleaned.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = cleaned.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += cleaned[index]! + cleaned[index + 1]!;
        index += 1;
      } else {
        result += "�";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "�";
      continue;
    }
    result += cleaned[index]!;
  }
  return result;
}

export function sanitizePgJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizePgText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePgJsonValue(item));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[sanitizePgText(key)] = sanitizePgJsonValue(item);
  }
  return result;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const isHigh = code <= 0xdbff;
    if (!isHigh) return true;
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}
