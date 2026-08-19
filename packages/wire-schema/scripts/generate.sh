#!/usr/bin/env bash
# Soulstream wire schema → Python TypedDict + TypeScript interface 생성.
# 정본: src/upstream.schema.json. 생성물은 generated/ 아래에 덮어쓴다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$HERE/src/upstream.schema.json"
PY_OUT="$HERE/generated/python/upstream.py"
TS_OUT="$HERE/generated/typescript/index.ts"

if [ ! -f "$SCHEMA" ]; then
  echo "ERROR: schema 파일이 없습니다: $SCHEMA" >&2
  exit 1
fi

mkdir -p "$(dirname "$PY_OUT")" "$(dirname "$TS_OUT")"

SCHEMA_SUMMARY="$(
  node - "$SCHEMA" <<'NODE'
const { readFileSync } = require("node:fs");

const schemaPath = process.argv[2];
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const defsCount = Object.keys(schema.$defs ?? {}).length;
const wireCount = Array.isArray(schema.oneOf) ? schema.oneOf.length : 0;
const sseCount = defsCount - wireCount;

console.log(
  `노드 ↔ 오케스트레이터 WebSocket 메시지 정본. ${defsCount}개 $defs (top-level wire ${wireCount} + supporting/SSE ${sseCount}). 출처: soul-server-ts/src/upstream/* · packages/wire-schema generated SSE types + OpenAI Agents SDK parity.`,
);
NODE
)"

echo "[wire-schema] Python TypedDict 생성: $PY_OUT"
datamodel-codegen \
  --input "$SCHEMA" \
  --input-file-type jsonschema \
  --output "$PY_OUT" \
  --output-model-type typing.TypedDict \
  --target-python-version 3.11 \
  --use-schema-description \
  --use-standard-collections \
  --use-union-operator \
  --formatters black isort \
  --disable-timestamp

# datamodel-code-generator가 실행 Python 버전에 따라 TypedDict를 typing과
# typing_extensions 양쪽에서 동시에 import하는 경우가 있다. closed TypedDict가 하나라도
# 있으면 typing_extensions가 정본이므로 중복 표면을 제거해 CI(3.11)와 dev(3.12) 출력을
# byte-for-byte 동일하게 유지한다.
node - "$PY_OUT" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const outputPath = process.argv[2];
let source = readFileSync(outputPath, "utf8");
if (source.includes("from typing_extensions import TypedDict")) {
  source = source.replace(
    /from typing import ([^\n]+), TypedDict\n/,
    "from typing import $1\n",
  );
}
writeFileSync(outputPath, source);
NODE

PY_TMP="$(mktemp)"
{
  echo "# AUTO-GENERATED — do not edit. Run packages/wire-schema/scripts/generate.sh"
  echo "# $SCHEMA_SUMMARY"
  echo "#"
  cat "$PY_OUT"
} > "$PY_TMP"
mv "$PY_TMP" "$PY_OUT"

echo "[wire-schema] TypeScript interface 생성: $TS_OUT"
# json-schema-to-typescript: 글로벌 설치된 경우 직접 호출, 없으면 npx로 fallback
if command -v json2ts >/dev/null 2>&1; then
  json2ts \
    --input "$SCHEMA" \
    --output "$TS_OUT" \
    --bannerComment '/* AUTO-GENERATED — do not edit. Run packages/wire-schema/scripts/generate.sh */' \
    --additionalProperties false
else
  npx --yes json-schema-to-typescript \
    --input "$SCHEMA" \
    --output "$TS_OUT" \
    --bannerComment '/* AUTO-GENERATED — do not edit. Run packages/wire-schema/scripts/generate.sh */' \
    --additionalProperties false
fi

# json-schema-to-typescript는 custom JSON Schema annotation을 출력하지 않는다.
# 이벤트 내구성 분류는 schema가 정본이며, TS consumer가 같은 정본을 직접 쓰도록
# 검증된 generated constant를 산출물 끝에 추가한다.
node - "$SCHEMA" "$TS_OUT" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const schemaPath = process.argv[2];
const outputPath = process.argv[3];
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const durability = schema["x-soulstream-event-durability"];
if (!durability || typeof durability !== "object" || Array.isArray(durability)) {
  throw new Error("x-soulstream-event-durability mapping is required");
}
const persistenceOnly = schema["x-soulstream-persistence-only-event-types"];
if (!Array.isArray(persistenceOnly) || persistenceOnly.some((eventType) => typeof eventType !== "string")) {
  throw new Error("x-soulstream-persistence-only-event-types string array is required");
}
if (new Set(persistenceOnly).size !== persistenceOnly.length) {
  throw new Error("x-soulstream-persistence-only-event-types must not contain duplicates");
}

const eventTypes = Object.entries(schema.$defs ?? {})
  .filter(([name]) => name.startsWith("SSEEvent"))
  .map(([name, definition]) => {
    const eventType = definition?.properties?.type?.const;
    if (typeof eventType !== "string") {
      throw new Error(`${name} must declare properties.type.const`);
    }
    return eventType;
  });
const eventTypeSet = new Set(eventTypes);
const overlap = persistenceOnly.filter((eventType) => eventTypeSet.has(eventType));
const classifiedEventTypes = [...eventTypes, ...persistenceOnly];
const classifiedEventTypeSet = new Set(classifiedEventTypes);
const missing = classifiedEventTypes.filter((eventType) => !(eventType in durability));
const extra = Object.keys(durability).filter((eventType) => !classifiedEventTypeSet.has(eventType));
const invalid = Object.entries(durability)
  .filter(([, classification]) => classification !== "durable" && classification !== "transient")
  .map(([eventType]) => eventType);
if (overlap.length > 0 || missing.length > 0 || extra.length > 0 || invalid.length > 0) {
  throw new Error(
    `invalid event durability mapping: overlap=${overlap.join(",")} missing=${missing.join(",")} extra=${extra.join(",")} invalid=${invalid.join(",")}`,
  );
}

const entries = Object.entries(durability)
  .map(([eventType, classification]) => `  ${JSON.stringify(eventType)}: ${JSON.stringify(classification)},`)
  .join("\n");
const generated = `

/**
 * Event persistence policy generated from upstream.schema.json.
 * Every SSE event and persistence-only event must be classified explicitly.
 */
export const EVENT_DURABILITY = {
${entries}
} as const;

export type PersistenceEventType = keyof typeof EVENT_DURABILITY;
export type EventDurability = (typeof EVENT_DURABILITY)[PersistenceEventType];
`;

writeFileSync(outputPath, `${readFileSync(outputPath, "utf8").trimEnd()}${generated}`);
NODE

echo "[wire-schema] 완료. generated/ 아래 산출물 확인."
