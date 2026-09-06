/**
 * The reasoning-effort picker on the options page.
 *
 * Split out of options.ts because the interesting part is asynchronous — two
 * fetches, a scope decision and an ordering guard — and options.ts runs
 * `loadOptions()` on import against the extension APIs. Everything except the
 * final DOM write is resolved here as a plain value, so it can be driven
 * directly in tests.
 */

import {
  buildAgentsEndpoint,
  buildModelPresetsEndpoint,
  effortsForPreset,
  resolveProfilePreset,
  type AdvertisedAgent,
  type AdvertisedModelPreset,
} from "./shared/schema.js";

/** The settings that decide what the picker may offer. */
export interface EffortScope {
  baseUrl: string;
  nodeId: string;
  profile: string;
  bearerToken: string;
}

export interface EffortPickerView {
  /** Full option list, leading entry first ("Server default" / "Preset default (…)"). */
  options: { value: string; label: string }[];
  /** Value to select. "" means "send nothing, let the node decide". */
  selected: string;
  /** Message under the picker. "" hides it. */
  note: string;
}

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
 * The node+profile the picker currently reflects. Only these two decide which
 * preset backs it; the URL and token decide whether the request succeeds, not
 * what it may return.
 */
let lastScopeKey: string | null = null;

function scopeKey(scope: EffortScope): string {
  return JSON.stringify([scope.nodeId, scope.profile]);
}

/**
 * What the picker should show after a settings field changed.
 *
 * A different node or profile means a different preset, so that preset's own
 * default applies and the previous pick is dropped — the same rule the web and
 * app surfaces follow. Re-querying the *same* scope (the URL or token changed)
 * keeps what is on screen; re-reading the saved value there would both override
 * the new preset's default and silently discard an unsaved pick.
 */
export function selectionForScope(scope: EffortScope, currentlyShown: string): string {
  return scopeKey(scope) === lastScopeKey ? currentlyShown : "";
}

/**
 * Resolves what to render from the model preset the configured profile actually
 * runs with. Returns null when a newer request has already superseded this one.
 *
 * A `selected` value the preset does not advertise is kept in the list and
 * flagged for re-selection — never silently rewritten to another level.
 */
export async function resolveEffortPickerView(
  scope: EffortScope,
  selected: string,
): Promise<EffortPickerView | null> {
  const sequence = ++populateSequence;
  lastScopeKey = scopeKey(scope);

  const headers: Record<string, string> = scope.bearerToken
    ? { Authorization: `Bearer ${scope.bearerToken}` }
    : {};
  let efforts: string[] = [];
  let presetDefault: string | undefined;
  let scopeLabel = "";
  let loadFailed = false;
  let presetUnresolved = false;
  try {
    const [presetsResponse, agentsResponse] = await Promise.all([
      fetch(buildModelPresetsEndpoint(scope.baseUrl, scope.nodeId), { headers }),
      fetch(buildAgentsEndpoint(scope.baseUrl, scope.nodeId), { headers }),
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
    const preset = scope.profile
      ? resolveProfilePreset(agents, presets, scope.profile)
      : undefined;
    if (preset) {
      efforts = effortsForPreset(preset);
      presetDefault = preset.default_effort;
      scopeLabel = preset.label || preset.id;
    } else {
      presetUnresolved = true;
    }
  } catch {
    loadFailed = true;
  }

  // A newer scope change already asked for a repaint; this response is stale.
  if (sequence !== populateSequence) return null;

  const options = [{
    value: "",
    label: presetDefault
      ? `Preset default (${EFFORT_LABELS[presetDefault] ?? presetDefault})`
      : "Server default",
  }];
  for (const effort of efforts) {
    options.push({ value: effort, label: EFFORT_LABELS[effort] ?? effort });
  }
  const selectedUnsupported = Boolean(selected) && !efforts.includes(selected);
  if (selectedUnsupported) {
    // Keep the value in the list so the user sees what must be re-chosen.
    options.push({
      value: selected,
      label: `${EFFORT_LABELS[selected] ?? selected} (unsupported)`,
    });
  }

  return {
    options,
    selected,
    note: pickerNote({
      loadFailed,
      presetUnresolved,
      selected,
      selectedUnsupported,
      scopeLabel,
      hasEfforts: efforts.length > 0,
    }),
  };
}

function pickerNote(state: {
  loadFailed: boolean;
  presetUnresolved: boolean;
  selected: string;
  selectedUnsupported: boolean;
  scopeLabel: string;
  hasEfforts: boolean;
}): string {
  if (state.loadFailed) {
    return "Could not load model presets. Set Soulstream URL, token and Node ID,"
      + " then reopen.";
  }
  if (state.presetUnresolved) {
    // Checked before the selected value: with no resolved preset there is
    // nothing to "pick a supported effort" from, so naming the real problem is
    // the only actionable message.
    return state.selected
      ? `Could not tell which model preset this profile runs with, so "${state.selected}"`
        + " cannot be confirmed and only the server default is offered."
        + " Check the profile and Node ID."
      : "Could not tell which model preset this profile runs with, so only the"
        + " server default is offered. Check the profile and Node ID.";
  }
  if (state.selectedUnsupported) {
    return state.scopeLabel
      ? `"${state.selected}" is not offered by ${state.scopeLabel}. Pick a supported effort.`
      : `"${state.selected}" is no longer offered by this node. Pick a supported effort.`;
  }
  if (!state.hasEfforts && state.scopeLabel) {
    // Says what we observed, not what the model can do: an operator catalogue
    // that has not been updated yet advertises nothing either.
    return `${state.scopeLabel} advertises no effort choices; the backend default applies.`;
  }
  return "";
}

/** Writes a resolved view into the options page. */
export function applyEffortPickerView(view: EffortPickerView): void {
  const select = document.querySelector<HTMLSelectElement>("#reasoning-effort");
  if (!select) return;
  select.replaceChildren();
  for (const option of view.options) {
    select.append(new Option(option.label, option.value));
  }
  select.value = view.selected;

  const note = document.querySelector<HTMLElement>("#reasoning-effort-note");
  if (!note) return;
  note.textContent = view.note;
  note.hidden = view.note === "";
}

/** Initial load: the saved value belongs to the scope it was saved in. */
export async function populateReasoningEfforts(
  scope: EffortScope,
  selected: string,
): Promise<void> {
  const view = await resolveEffortPickerView(scope, selected);
  if (view) applyEffortPickerView(view);
}

/** Re-query after a settings field changed. */
export async function refreshReasoningEfforts(scope: EffortScope): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>("#reasoning-effort");
  const shown = select?.value ?? "";
  const selected = selectionForScope(scope, shown);
  if (select && selected !== shown) {
    // Applied now, not when the response lands. `resolveEffortPickerView` marks
    // the new scope as current immediately, so a second refresh arriving while
    // the first is still in flight would otherwise read the *previous* scope's
    // value off the picker and re-adopt it as if it belonged to this one.
    select.value = selected;
  }
  await populateReasoningEfforts(scope, selected);
}

/** Test seam: the sequence counter and current scope are module-level state. */
export function resetReasoningEffortsForTest(): void {
  populateSequence = 0;
  lastScopeKey = null;
}
