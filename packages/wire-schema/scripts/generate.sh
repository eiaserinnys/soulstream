#!/usr/bin/env bash
# Soulstream wire schema → TypeScript interface 생성.
# 정본: src/upstream.schema.json. 생성물은 generated/typescript/ 아래에 덮어쓴다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$HERE/src/upstream.schema.json"
TS_OUT="$HERE/generated/typescript/index.ts"

if [ ! -f "$SCHEMA" ]; then
  echo "ERROR: schema 파일이 없습니다: $SCHEMA" >&2
  exit 1
fi

mkdir -p "$(dirname "$TS_OUT")"
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
# 런타임 목록과 유니온 타입은 schema metadata에서 생성한다.
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
const controlCommandTypes = schema["x-soulstream-control-command-types"];
if (!Array.isArray(controlCommandTypes) || controlCommandTypes.some((commandType) => typeof commandType !== "string")) {
  throw new Error("x-soulstream-control-command-types string array is required");
}
if (new Set(controlCommandTypes).size !== controlCommandTypes.length) {
  throw new Error("x-soulstream-control-command-types must not contain duplicates");
}
const schemaWireTypes = new Set(
  Object.values(schema.$defs ?? {}).map((definition) => definition?.properties?.type?.const),
);
const rootWireTypes = new Set(
  (schema.oneOf ?? []).map((entry) => {
    const name = entry?.$ref?.split("/").at(-1);
    return schema.$defs?.[name]?.properties?.type?.const;
  }),
);
const missingCommandTypes = controlCommandTypes.filter(
  (commandType) => !schemaWireTypes.has(commandType) || !rootWireTypes.has(commandType),
);
if (missingCommandTypes.length > 0) {
  throw new Error(`control command types missing from wire schema: ${missingCommandTypes.join(",")}`);
}
const eventIngressRejectionCodes = schema["x-soulstream-event-ingress-rejection-codes"];
if (!Array.isArray(eventIngressRejectionCodes) || eventIngressRejectionCodes.some((code) => typeof code !== "string" || !code.startsWith("EVENT_INGRESS_"))) {
  throw new Error("x-soulstream-event-ingress-rejection-codes must be EVENT_INGRESS_ string array");
}
if (new Set(eventIngressRejectionCodes).size !== eventIngressRejectionCodes.length) {
  throw new Error("x-soulstream-event-ingress-rejection-codes must not contain duplicates");
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
const timelineEventTypes = schema["x-soulstream-session-timeline-event-types"];
if (!Array.isArray(timelineEventTypes) || timelineEventTypes.some((eventType) => typeof eventType !== "string")) {
  throw new Error("x-soulstream-session-timeline-event-types string array is required");
}
if (new Set(timelineEventTypes).size !== timelineEventTypes.length) {
  throw new Error("x-soulstream-session-timeline-event-types must not contain duplicates");
}
const invalidTimelineEventTypes = timelineEventTypes.filter((eventType) => !eventTypeSet.has(eventType));
if (invalidTimelineEventTypes.length > 0) {
  throw new Error(`session timeline event types missing from SSE schema: ${invalidTimelineEventTypes.join(",")}`);
}
const callerInfoSources = schema["x-soulstream-caller-info-sources"];
if (!Array.isArray(callerInfoSources) || callerInfoSources.some((source) => typeof source !== "string")) {
  throw new Error("x-soulstream-caller-info-sources string array is required");
}
if (new Set(callerInfoSources).size !== callerInfoSources.length) {
  throw new Error("x-soulstream-caller-info-sources must not contain duplicates");
}
const callerInfoSourceSchema = schema.$defs?.CallerInfoSource?.enum;
if (!Array.isArray(callerInfoSourceSchema)
  || callerInfoSourceSchema.length !== callerInfoSources.length
  || callerInfoSourceSchema.some((source, index) => source !== callerInfoSources[index])) {
  throw new Error("CallerInfoSource enum must match x-soulstream-caller-info-sources");
}
const sharedStringSets = [
  ["x-soulstream-session-statuses", "session statuses"],
  ["x-soulstream-checklist-item-statuses", "checklist item statuses"],
  ["x-soulstream-board-item-types", "board item types"],
];
for (const [key, label] of sharedStringSets) {
  const values = schema[key];
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string")) {
    throw new Error(`${key} non-empty string array is required`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${key} must not contain duplicates`);
  }
}
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
const generatedStringArray = (name, values) =>
  `export const ${name} = [\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n] as const;`;
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

${generatedStringArray("SSE_EVENT_TYPES", eventTypes)}
export type SSEEventType = (typeof SSE_EVENT_TYPES)[number];

${generatedStringArray("SESSION_TIMELINE_EVENT_TYPES", timelineEventTypes)}
export type SessionTimelineEventType = (typeof SESSION_TIMELINE_EVENT_TYPES)[number];

${generatedStringArray("SESSION_STATUSES", schema["x-soulstream-session-statuses"])}
export type SessionStatus = (typeof SESSION_STATUSES)[number];

${generatedStringArray("CALLER_INFO_SOURCES", callerInfoSources)}

${generatedStringArray("CHECKLIST_ITEM_STATUSES", schema["x-soulstream-checklist-item-statuses"])}
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

${generatedStringArray("BOARD_ITEM_TYPES", schema["x-soulstream-board-item-types"])}
export type BoardItemType = (typeof BOARD_ITEM_TYPES)[number];

${generatedStringArray("CONTROL_COMMAND_TYPES", controlCommandTypes)}
export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];

${generatedStringArray("EVENT_INGRESS_REJECTION_CODES", eventIngressRejectionCodes)}
export type EventIngressRejectionCode = (typeof EVENT_INGRESS_REJECTION_CODES)[number];
`;

writeFileSync(outputPath, `${readFileSync(outputPath, "utf8").trimEnd()}${generated}`);
NODE

echo "[wire-schema] 완료. generated/ 아래 산출물 확인."
