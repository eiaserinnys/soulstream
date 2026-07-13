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
  `노드 ↔ 오케스트레이터 WebSocket 메시지 정본. ${defsCount}개 $defs (wire ${wireCount} + SSE event ${sseCount}). 출처: soul-server-ts/src/upstream/* · packages/wire-schema generated SSE types + OpenAI Agents SDK parity.`,
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

echo "[wire-schema] 완료. generated/ 아래 산출물 확인."
