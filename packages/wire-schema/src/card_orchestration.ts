/** Canonical admin policy and tool-less decision wire contract. */
export const ORCHESTRATION_USAGE_MAX_AGE_MS = 300000 as const;
export const ORCHESTRATION_DECISION_PURPOSE =
  "card_orchestration_decision" as const;
export interface OrchestrationCandidate {
  agentId: string;
  nodeId: string;
  modelPreset: string;
  minimumRemainingPercent: number;
}
export interface OrchestrationPolicy {
  enabled: boolean;
  candidates: OrchestrationCandidate[];
  usageMaxAgeMs: typeof ORCHESTRATION_USAGE_MAX_AGE_MS;
  sessionFolderId: string | null;
  systemFolderParentId: string | null;
}
export interface OrchestrationSettings {
  key: "card_orchestration";
  policy: OrchestrationPolicy;
  version: number;
  updatedAt: string;
  updatedBy: string;
}
export interface CandidateSnapshot {
  cardId: string;
  cardVersion: number;
  [key: string]: unknown;
}
export interface OrchestrationDecisionItem {
  cardId: string;
  cardVersion: number;
  action: "run" | "defer";
  reason: string;
}
export interface OrchestrationDecision {
  decisions: OrchestrationDecisionItem[];
}
const uuid = { type: ["string", "null"], format: "uuid" };
export const OrchestrationPolicySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "enabled",
    "candidates",
    "usageMaxAgeMs",
    "sessionFolderId",
    "systemFolderParentId",
  ],
  properties: {
    enabled: { type: "boolean" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "agentId",
          "nodeId",
          "modelPreset",
          "minimumRemainingPercent",
        ],
        properties: {
          agentId: { type: "string", minLength: 1 },
          nodeId: { type: "string", minLength: 1 },
          modelPreset: { type: "string", minLength: 1 },
          minimumRemainingPercent: { type: "number", minimum: 0, maximum: 100 },
        },
      },
    },
    usageMaxAgeMs: { type: "integer", const: ORCHESTRATION_USAGE_MAX_AGE_MS },
    sessionFolderId: uuid,
    systemFolderParentId: uuid,
  },
} as const;
export const OrchestrationDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cardId", "cardVersion", "action", "reason"],
        properties: {
          cardId: { type: "string", minLength: 1 },
          cardVersion: { type: "integer", minimum: 1 },
          action: { type: "string", enum: ["run", "defer"] },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
/** No coercion or stripping: policy keys have exactly one canonical meaning. */
export function parseOrchestrationPolicy(input: unknown): OrchestrationPolicy {
  const obj = exact(input, [
    "enabled",
    "candidates",
    "usageMaxAgeMs",
    "sessionFolderId",
    "systemFolderParentId",
  ]);
  if (
    typeof obj.enabled !== "boolean" ||
    obj.usageMaxAgeMs !== ORCHESTRATION_USAGE_MAX_AGE_MS ||
    !Array.isArray(obj.candidates)
  )
    throw new TypeError(
      "enabled, candidates and usageMaxAgeMs=300000 are required",
    );
  const candidates = obj.candidates.map((value) => {
    const c = exact(value, [
      "agentId",
      "nodeId",
      "modelPreset",
      "minimumRemainingPercent",
    ]);
    if (
      typeof c.minimumRemainingPercent !== "number" ||
      !Number.isFinite(c.minimumRemainingPercent) ||
      c.minimumRemainingPercent < 0 ||
      c.minimumRemainingPercent > 100
    )
      throw new TypeError("minimumRemainingPercent must be between 0 and 100");
    return {
      agentId: text(c.agentId),
      nodeId: text(c.nodeId),
      modelPreset: text(c.modelPreset),
      minimumRemainingPercent: c.minimumRemainingPercent,
    };
  });
  return {
    enabled: obj.enabled,
    candidates,
    usageMaxAgeMs: ORCHESTRATION_USAGE_MAX_AGE_MS,
    sessionFolderId: folder(obj.sessionFolderId),
    systemFolderParentId: folder(obj.systemFolderParentId),
  };
}
export function parseOrchestrationDecision(
  input: unknown,
): OrchestrationDecision {
  const obj = exact(input, ["decisions"]);
  if (!Array.isArray(obj.decisions))
    throw new TypeError("decisions must be an array");
  return {
    decisions: obj.decisions.map((value) => {
      const item = exact(value, ["cardId", "cardVersion", "action", "reason"]);
      if (
        !Number.isSafeInteger(item.cardVersion) ||
        (item.cardVersion as number) < 1 ||
        (item.action !== "run" && item.action !== "defer")
      )
        throw new TypeError("cardVersion and action are invalid");
      return {
        cardId: text(item.cardId),
        cardVersion: item.cardVersion as number,
        action: item.action,
        reason: text(item.reason),
      };
    }),
  };
}
function exact(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Expected object");
  const obj = input as Record<string, unknown>;
  if (
    Object.keys(obj).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(obj, key)) ||
    Object.keys(obj).some((key) => !keys.includes(key))
  )
    throw new TypeError(`Expected exactly: ${keys.join(", ")}`);
  return obj;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("Expected nonempty string");
  return value;
}
function folder(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new TypeError("Folder ID must be UUID or null");
  return value;
}
