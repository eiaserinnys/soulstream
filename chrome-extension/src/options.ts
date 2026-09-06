import {
  DEFAULT_CONFIG,
  buildModelPresetsEndpoint,
  buildSessionEndpoint,
  collectAdvertisedEfforts,
  mergeConfig,
  normalizeBaseUrl,
  normalizeBodyCharLimit,
  type AdvertisedModelPreset,
  type ExtensionConfig,
} from "./shared/schema.js";
import { sessionHeaders } from "./shared/soulstream.js";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const status = document.querySelector<HTMLElement>("#status");
const testButton = document.querySelector<HTMLButtonElement>("#test-connection");

void loadOptions();

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveOptions();
});

testButton?.addEventListener("click", () => {
  void testConnection();
});

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X High",
  max: "Max",
  ultra: "Ultra",
};

/**
 * Fills the effort picker from the node's model catalog. A stored value the node
 * no longer advertises is kept selected and flagged for re-selection — never
 * silently rewritten to another level.
 */
async function populateReasoningEfforts(config: ExtensionConfig): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>("#reasoning-effort");
  const note = document.querySelector<HTMLElement>("#reasoning-effort-note");
  if (!select) return;

  let efforts: string[] = [];
  let loadFailed = false;
  try {
    const response = await fetch(buildModelPresetsEndpoint(config.baseUrl, config.nodeId), {
      headers: config.bearerToken
        ? { Authorization: `Bearer ${config.bearerToken}` }
        : {},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { model_presets?: AdvertisedModelPreset[] };
    efforts = collectAdvertisedEfforts(body.model_presets ?? []);
  } catch {
    loadFailed = true;
  }

  select.replaceChildren();
  select.append(new Option("Server default", ""));
  for (const effort of efforts) {
    select.append(new Option(EFFORT_LABELS[effort] ?? effort, effort));
  }

  const stored = config.reasoningEffort;
  const storedUnsupported = Boolean(stored) && !efforts.includes(stored);
  if (storedUnsupported) {
    // Keep the saved value visible so the user sees what must be re-chosen.
    select.append(new Option(`${EFFORT_LABELS[stored] ?? stored} (unsupported)`, stored));
  }
  select.value = stored;

  if (note) {
    if (loadFailed) {
      note.textContent =
        "Could not load model presets. Set Soulstream URL, token and Node ID, then reopen.";
      note.hidden = false;
    } else if (storedUnsupported) {
      note.textContent =
        `"${stored}" is no longer offered by this node. Pick a supported effort.`;
      note.hidden = false;
    } else {
      note.textContent = "";
      note.hidden = true;
    }
  }
}

async function loadOptions(): Promise<void> {
  const config = await readConfig();
  setInput("base-url", config.baseUrl);
  setInput("bearer-token", config.bearerToken);
  setInput("node-id", config.nodeId);
  setInput("profile", config.profile);
  setInput("folder-id", config.folderId);
  await populateReasoningEfforts(config);
  setInput("body-char-limit", String(config.bodyCharLimit));
  const includeBody = document.querySelector<HTMLInputElement>("#include-body");
  if (includeBody) includeBody.checked = config.includeBody;
}

async function saveOptions(): Promise<void> {
  const config: ExtensionConfig = {
    baseUrl: normalizeBaseUrl(readInput("base-url")),
    bearerToken: readInput("bearer-token"),
    nodeId: readInput("node-id"),
    profile: readInput("profile"),
    folderId: readInput("folder-id"),
    reasoningEffort: readInput("reasoning-effort") as ExtensionConfig["reasoningEffort"],
    includeBody: document.querySelector<HTMLInputElement>("#include-body")?.checked ?? true,
    bodyCharLimit: normalizeBodyCharLimit(readInput("body-char-limit")),
  };
  await writeConfig(config);
  setStatus("Saved.");
}

async function testConnection(): Promise<void> {
  const config = await readConfig();
  if (!config.baseUrl) {
    setStatus("Soulstream URL is not configured.");
    return;
  }
  try {
    const url = buildSessionEndpoint(config.baseUrl).replace(/\/sessions$/, "/nodes");
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: sessionHeaders(config),
    });
    if (!response.ok) {
      setStatus(`Connection failed: HTTP ${response.status}`);
      return;
    }
    const data = await response.json() as { nodes?: unknown[] };
    const count = Array.isArray(data.nodes) ? data.nodes.length : 0;
    setStatus(`Connected. ${count} node(s) visible.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Connection failed.");
  }
}

function readConfig(): Promise<ExtensionConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULT_CONFIG), (items) => {
      resolve(mergeConfig(items as Partial<Record<keyof ExtensionConfig, unknown>>));
    });
  });
}

function writeConfig(config: ExtensionConfig): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ ...config }, resolve);
  });
}

function readInput(id: string): string {
  return document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value.trim() ?? "";
}

function setInput(id: string, value: string): void {
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  if (element) element.value = value;
}

function setStatus(message: string): void {
  if (status) status.textContent = message;
}
