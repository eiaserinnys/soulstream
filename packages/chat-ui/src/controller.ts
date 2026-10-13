import type { ChatUiState, Field, FieldValue, Key, NormalizedChatUiDocumentV1 } from "./types.js";

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function copyInitial(field: Field): FieldValue {
  return field.type === "selection" ? [...field.initial] : field.initial;
}

export function initialState(doc: NormalizedChatUiDocumentV1): ChatUiState {
  const values = Object.create(null) as Record<Key, FieldValue>;
  for (const key of Object.keys(doc.fields)) values[key] = copyInitial(doc.fields[key]!);
  return { values };
}

function isValidFieldValue(field: Field, value: FieldValue): boolean {
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "text") return typeof value === "string";
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "choice") return typeof value === "string" && field.options.some((option) => option.id === value);
  return Array.isArray(value)
    && value.every((id) => typeof id === "string" && field.options.some((option) => option.id === id))
    && new Set(value).size === value.length;
}

function equalFieldValue(left: FieldValue | undefined, right: FieldValue): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return Object.is(left, right);
}

function normalizeFieldValue(field: Field, value: FieldValue): FieldValue {
  if (field.type === "number") {
    const clamped = Math.min(field.max, Math.max(field.min, value as number));
    const steps = Math.round((clamped - field.min) / field.step);
    const snapped = field.min + steps * field.step;
    const rounded = Number(snapped.toFixed(10));
    return Math.min(field.max, Math.max(field.min, rounded));
  }
  if (field.type === "text") return [...(value as string)].slice(0, field.maxLength).join("");
  return Array.isArray(value) ? [...value] : value;
}

export function reduce(
  doc: NormalizedChatUiDocumentV1,
  state: ChatUiState,
  event: { type: "set"; field: Key; value: FieldValue } | { type: "reset" },
): ChatUiState {
  if (event.type === "reset") return initialState(doc);
  if (!hasOwn(doc.fields, event.field) || !hasOwn(state.values, event.field)) return state;
  const field = doc.fields[event.field]!;
  if (!isValidFieldValue(field, event.value)) return state;
  const value = normalizeFieldValue(field, event.value);
  if (equalFieldValue(state.values[event.field], value)) return state;
  return {
    values: { ...state.values, [event.field]: value },
  };
}
