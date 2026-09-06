export const PAGE_ACTIONS = [
  "bookmark",
  "bookmark_digest",
  "reference",
  "reference_digest",
] as const;

export type PageAction = (typeof PAGE_ACTIONS)[number];

/**
 * Read vocabulary only. Which values are *offered* comes from the node's model
 * preset advertisement — this extension must not carry its own list.
 */
export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export const REASONING_EFFORT_ACCEPT_SET: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export interface AdvertisedModelPreset {
  id: string;
  label: string;
  supported_efforts?: readonly string[];
  default_effort?: string;
}

export interface AdvertisedAgent {
  id: string;
  default_preset?: string | null;
}

export function buildAgentsEndpoint(baseUrl: string, nodeId: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error("Soulstream URL is not configured");
  if (!nodeId) throw new Error("Node ID is not configured");
  return `${normalized}/api/nodes/${encodeURIComponent(nodeId)}/agents`;
}

/**
 * The preset the configured profile would actually run with. Offering the union
 * of every preset on the node would let a Claude profile pick `ultra` (which
 * only a Codex preset advertises) and get rejected at creation time.
 */
export function resolveProfilePreset(
  agents: readonly AdvertisedAgent[],
  presets: readonly AdvertisedModelPreset[],
  profile: string,
): AdvertisedModelPreset | undefined {
  const presetId = agents.find((agent) => agent.id === profile)?.default_preset;
  if (!presetId) return undefined;
  return presets.find((preset) => preset.id === presetId);
}

export function effortsForPreset(
  preset: AdvertisedModelPreset | undefined,
): ReasoningEffort[] {
  const supported = preset?.supported_efforts ?? [];
  return REASONING_EFFORT_ACCEPT_SET.filter((effort) => supported.includes(effort));
}

export function buildModelPresetsEndpoint(baseUrl: string, nodeId: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error("Soulstream URL is not configured");
  if (!nodeId) throw new Error("Node ID is not configured");
  return `${normalized}/api/nodes/${encodeURIComponent(nodeId)}/model-presets`;
}

export interface MenuActionDefinition {
  id: PageAction;
  title: string;
  instruction: string;
}

export const MENU_ACTIONS: readonly MenuActionDefinition[] = [
  {
    id: "bookmark",
    title: "북마크하기",
    instruction: "이 페이지를 북마크로 저장해줘. 필요한 태그와 짧은 메모를 함께 남겨줘.",
  },
  {
    id: "bookmark_digest",
    title: "북마크 + 다이제스트 포스트하기",
    instruction: "이 페이지를 북마크로 저장하고 다이제스트 포스트 초안을 작성해줘.",
  },
  {
    id: "reference",
    title: "레퍼런스 정리하기",
    instruction: "이 페이지를 레퍼런스로 정리해줘. 핵심 주장, 출처, 인용 후보, 활용 맥락을 분리해줘.",
  },
  {
    id: "reference_digest",
    title: "레퍼런스 정리 + 다이제스트 포스트하기",
    instruction: "이 페이지를 레퍼런스로 정리하고 다이제스트 포스트 초안을 작성해줘.",
  },
] as const;

export const DEFAULT_BODY_CHAR_LIMIT = 12_000;
export const MAX_BODY_CHAR_LIMIT = 50_000;

export interface ExtensionConfig {
  baseUrl: string;
  bearerToken: string;
  nodeId: string;
  profile: string;
  folderId: string;
  reasoningEffort: ReasoningEffort | "";
  includeBody: boolean;
  bodyCharLimit: number;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  baseUrl: "",
  bearerToken: "",
  nodeId: "",
  profile: "",
  folderId: "",
  reasoningEffort: "",
  includeBody: true,
  bodyCharLimit: DEFAULT_BODY_CHAR_LIMIT,
};

export type ExtractionStatus = "complete" | "partial" | "fallback" | "failed";

export interface PageActionPayload {
  action: PageAction;
  url: string;
  title: string;
  selectionText: string;
  metaDescription: string;
  bodyText: string;
  bodyTruncated: boolean;
  bodyCharLimit: number;
  extractionStatus: ExtractionStatus;
  extractionError?: string;
  source: "content-script" | "tab-fallback";
}

export interface CreateSessionRequest {
  prompt: string;
  nodeId?: string;
  folderId?: string;
  profile?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface CreateSessionResponse {
  agentSessionId: string;
  nodeId?: string;
}

export function isPageAction(value: unknown): value is PageAction {
  return typeof value === "string" && PAGE_ACTIONS.includes(value as PageAction);
}

export function actionDefinition(action: PageAction): MenuActionDefinition {
  return MENU_ACTIONS.find((item) => item.id === action) ?? MENU_ACTIONS[0];
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeBodyCharLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BODY_CHAR_LIMIT;
  if (parsed < 0) return 0;
  if (parsed > MAX_BODY_CHAR_LIMIT) return MAX_BODY_CHAR_LIMIT;
  return Math.floor(parsed);
}

export function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function truncateText(value: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0) return { text: "", truncated: value.length > 0 };
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}

export function mergeConfig(raw: Partial<Record<keyof ExtensionConfig, unknown>>): ExtensionConfig {
  return {
    baseUrl: trimText(raw.baseUrl ?? DEFAULT_CONFIG.baseUrl),
    bearerToken: trimText(raw.bearerToken ?? DEFAULT_CONFIG.bearerToken),
    nodeId: trimText(raw.nodeId ?? DEFAULT_CONFIG.nodeId),
    profile: trimText(raw.profile ?? DEFAULT_CONFIG.profile),
    folderId: trimText(raw.folderId ?? DEFAULT_CONFIG.folderId),
    reasoningEffort: isReasoningEffort(raw.reasoningEffort) ? raw.reasoningEffort : "",
    includeBody: typeof raw.includeBody === "boolean" ? raw.includeBody : DEFAULT_CONFIG.includeBody,
    bodyCharLimit: normalizeBodyCharLimit(raw.bodyCharLimit ?? DEFAULT_CONFIG.bodyCharLimit),
  };
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string"
    && (REASONING_EFFORT_ACCEPT_SET as readonly string[]).includes(value);
}

export function isRestrictedUrl(url: string): boolean {
  return /^(chrome|chrome-extension|edge|about|file|view-source):/i.test(url);
}

export function buildSessionEndpoint(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) throw new Error("Soulstream URL is not configured");
  return `${normalized}/api/sessions`;
}

export function buildCreateSessionRequest(config: ExtensionConfig, prompt: string): CreateSessionRequest {
  const request: CreateSessionRequest = { prompt };
  if (config.nodeId) request.nodeId = config.nodeId;
  if (config.folderId) request.folderId = config.folderId;
  if (config.profile) request.profile = config.profile;
  if (config.reasoningEffort) request.reasoningEffort = config.reasoningEffort;
  return request;
}
