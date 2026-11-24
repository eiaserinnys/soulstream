import type { Definition, McpType } from "../../lib/mcp-api";

export type Unit = {
  id: string;
  kind: "header" | "query" | "env";
  name: string;
  value: string | { env: string };
  originalQuery?: {
    rawName: string;
    rawValue: string;
    name: string;
    value: string;
  };
};
export type DefinitionDraft = {
  name: string;
  type: McpType;
  config: Record<string, unknown>;
  url: string;
  units: Unit[];
  queryOrder: ({ unitId: string } | { literal: string })[];
  fragment: string;
};
export const newUnit = (unit: Omit<Unit, "id">): Unit => ({
  id: crypto.randomUUID(),
  ...unit,
});
export function pendingSecrets(
  drafts: DefinitionDraft[],
  pending: Record<string, { name: string; value: string }>,
): Record<string, string> {
  return Object.fromEntries(
    drafts
      .flatMap((draft) => draft.units)
      .flatMap((unit) =>
        pending[unit.id]
          ? [[pending[unit.id].name, pending[unit.id].value]]
          : [],
      ),
  );
}
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** 한 값이 참조 자체와 접두어(Bearer 등)를 함께 보존한다. */
export function reference(value: Unit["value"]): {
  kind: "secret" | "env" | "literal";
  name: string;
} {
  if (typeof value !== "string") return { kind: "env", name: value.env };
  const match = /\{\{(secret|env):([^}]*)\}\}/.exec(value);
  return match
    ? { kind: match[1] as "secret" | "env", name: match[2] }
    : { kind: "literal", name: "" };
}
export function validateUnits(
  drafts: DefinitionDraft[],
  secretNames: string[],
  pending: Record<string, string>,
): string | null {
  for (const draft of drafts)
    for (const unit of draft.units) {
      if (!unit.name.trim()) return "값 단위의 이름을 입력해 주세요.";
      if (
        typeof unit.value === "string" &&
        /\{\{(?:secret|env):\}\}/.test(unit.value)
      )
        return "참조 이름이나 새 값을 입력해 주세요.";
      const ref = reference(unit.value);
      if (
        ref.kind === "secret" &&
        !secretNames.includes(ref.name) &&
        !(ref.name in pending)
      )
        return `비밀 ${ref.name}이 DB에 없습니다. 값을 입력하거나 저장된 비밀을 선택해 주세요.`;
    }
  return null;
}
export function readDefinition(definition: Definition): DefinitionDraft {
  const config = structuredClone(definition.config);
  const units: Unit[] = [];
  for (const [key, kind] of [
    ["headers", "header"],
    ["env", "env"],
  ] as const) {
    if ((definition.type === "stdio") !== (key === "env")) continue;
    const record = config[key];
    if (record && typeof record === "object" && !Array.isArray(record)) {
      for (const [name, value] of Object.entries(record))
        if (
          typeof value === "string" ||
          (value &&
            typeof value === "object" &&
            typeof (value as { env?: unknown }).env === "string")
        )
          units.push(newUnit({ kind, name, value: value as Unit["value"] }));
    }
    delete config[key];
  }
  let url =
    definition.type !== "stdio" && typeof config.url === "string"
      ? config.url
      : "";
  let fragment = "";
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash);
    url = url.slice(0, hash);
  }
  const queryOrder: DefinitionDraft["queryOrder"] = [];
  const q = url.indexOf("?");
  if (q >= 0) {
    const query = url.slice(q + 1);
    url = url.slice(0, q);
    for (const part of query.split("&")) {
      const at = part.indexOf("=");
      if (at >= 0) {
        const rawName = part.slice(0, at),
          rawValue = part.slice(at + 1);
        const name = decode(rawName.replace(/\+/g, " ")),
          value = decode(rawValue);
        const unit = newUnit({
          kind: "query",
          name,
          value,
          originalQuery: { rawName, rawValue, name, value },
        });
        units.push(unit);
        queryOrder.push({ unitId: unit.id });
      } else queryOrder.push({ literal: part });
    }
  }
  if (definition.type !== "stdio") delete config.url;
  return {
    name: definition.name ?? "",
    type: definition.type,
    config,
    url,
    units,
    queryOrder,
    fragment,
  };
}
export function writeDefinition(draft: DefinitionDraft): Definition {
  const config = { ...draft.config };
  if (draft.type !== "stdio") {
    const queryUnits = draft.units.filter((unit) => unit.kind === "query");
    const encodeUnit = (unit: Unit) => {
      if (
        unit.originalQuery &&
        unit.name === unit.originalQuery.name &&
        unit.value === unit.originalQuery.value
      )
        return `${unit.originalQuery.rawName}=${unit.originalQuery.rawValue}`;
      return `${encodeURIComponent(unit.name)}=${encodeURIComponent(typeof unit.value === "string" ? unit.value : `{{env:${unit.value.env}}}`)}`;
    };
    const orderedIds = new Set<string>();
    const query = draft.queryOrder.flatMap((part) => {
      if ("literal" in part) return [part.literal];
      orderedIds.add(part.unitId);
      const unit = queryUnits.find((item) => item.id === part.unitId);
      return unit ? [encodeUnit(unit)] : [];
    });
    query.push(
      ...queryUnits.filter((unit) => !orderedIds.has(unit.id)).map(encodeUnit),
    );
    config.url =
      draft.url + (query.length ? `?${query.join("&")}` : "") + draft.fragment;
  }
  for (const [kind, key] of [
    ["header", "headers"],
    ["env", "env"],
  ] as const) {
    const entries = draft.units
      .filter((unit) => unit.kind === kind)
      .map((unit) => [unit.name, unit.value]);
    if (entries.length) config[key] = Object.fromEntries(entries);
  }
  return {
    ...(draft.name ? { name: draft.name } : {}),
    type: draft.type,
    config,
  };
}
