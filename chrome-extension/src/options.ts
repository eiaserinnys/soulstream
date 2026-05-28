import {
  DEFAULT_CONFIG,
  buildSessionEndpoint,
  mergeConfig,
  normalizeBaseUrl,
  normalizeBodyCharLimit,
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

async function loadOptions(): Promise<void> {
  const config = await readConfig();
  setInput("base-url", config.baseUrl);
  setInput("bearer-token", config.bearerToken);
  setInput("node-id", config.nodeId);
  setInput("profile", config.profile);
  setInput("folder-id", config.folderId);
  setInput("reasoning-effort", config.reasoningEffort);
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
