import {
  DEFAULT_CONFIG,
  buildAgentsEndpoint,
  buildModelPresetsEndpoint,
  buildSessionEndpoint,
  effortsForPreset,
  resolveProfilePreset,
  mergeConfig,
  normalizeBaseUrl,
  normalizeBodyCharLimit,
  type AdvertisedAgent,
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
 * Guards against out-of-order catalog responses: every scope field commit fires
 * its own request, and a slow earlier node must not repaint the picker after a
 * later one already did.
 */
let populateSequence = 0;

/**
 * Fills the effort picker from the model preset the configured profile actually
 * runs with. A stored value that preset no longer advertises is kept selected and
 * flagged for re-selection — never silently rewritten to another level.
 */
async function populateReasoningEfforts(config: ExtensionConfig): Promise<void> {
  const sequence = ++populateSequence;
  const select = document.querySelector<HTMLSelectElement>("#reasoning-effort");
  const note = document.querySelector<HTMLElement>("#reasoning-effort-note");
  if (!select) return;

  const headers: Record<string, string> = config.bearerToken
    ? { Authorization: `Bearer ${config.bearerToken}` }
    : {};
  let efforts: string[] = [];
  let presetDefault: string | undefined;
  let scope = "";
  let loadFailed = false;
  let presetUnresolved = false;
  try {
    const [presetsResponse, agentsResponse] = await Promise.all([
      fetch(buildModelPresetsEndpoint(config.baseUrl, config.nodeId), { headers }),
      fetch(buildAgentsEndpoint(config.baseUrl, config.nodeId), { headers }),
    ]);
    if (!presetsResponse.ok) throw new Error(`HTTP ${presetsResponse.status}`);
    const presetBody = (await presetsResponse.json()) as {
      model_presets?: AdvertisedModelPreset[];
    };
    const presets = presetBody.model_presets ?? [];
    const agents = agentsResponse.ok
      ? ((await agentsResponse.json()) as { agents?: AdvertisedAgent[] }).agents ?? []
      : [];

    // Scoped to the preset this profile actually runs with, so the picker cannot
    // offer a value that preset would reject at creation time. With no resolved
    // preset we know nothing, so only the server default is offered — the union
    // across the node's presets would advertise levels this profile cannot use.
    const preset = config.profile
      ? resolveProfilePreset(agents, presets, config.profile)
      : undefined;
    if (preset) {
      efforts = effortsForPreset(preset);
      presetDefault = preset.default_effort;
      scope = preset.label || preset.id;
    } else {
      presetUnresolved = true;
    }
  } catch {
    loadFailed = true;
  }

  // A newer scope change already repainted the picker; this response is stale.
  if (sequence !== populateSequence) return;

  select.replaceChildren();
  select.append(new Option(
    presetDefault
      ? `Preset default (${EFFORT_LABELS[presetDefault] ?? presetDefault})`
      : "Server default",
    "",
  ));
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
    } else if (presetUnresolved) {
      // Checked before the stored value: with no resolved preset there is
      // nothing to "pick a supported effort" from, so naming the real problem
      // is the only actionable message.
      note.textContent = stored
        ? `Could not tell which model preset this profile runs with, so "${stored}"`
          + " cannot be confirmed and only the server default is offered."
          + " Check the profile and Node ID."
        : "Could not tell which model preset this profile runs with, so only the"
          + " server default is offered. Check the profile and Node ID.";
      note.hidden = false;
    } else if (storedUnsupported) {
      note.textContent = scope
        ? `"${stored}" is not offered by ${scope}. Pick a supported effort.`
        : `"${stored}" is no longer offered by this node. Pick a supported effort.`;
      note.hidden = false;
    } else if (efforts.length === 0) {
      note.textContent = scope
        ? `${scope} has no effort control; the backend default applies.`
        : "";
      note.hidden = !scope;
    } else {
      note.textContent = "";
      note.hidden = true;
    }
  }
}

/** Profile or node changes move the effort scope, so re-populate the picker. */
function refreshOnScopeChange(): void {
  for (const id of ["profile", "node-id", "base-url", "bearer-token"]) {
    document.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener(
      "change",
      () => {
        void readConfig().then((stored) => populateReasoningEfforts({
          ...stored,
          nodeId: readInput("node-id"),
          profile: readInput("profile"),
          baseUrl: normalizeBaseUrl(readInput("base-url")),
          bearerToken: readInput("bearer-token"),
        }));
      },
    );
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
  refreshOnScopeChange();
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
