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
