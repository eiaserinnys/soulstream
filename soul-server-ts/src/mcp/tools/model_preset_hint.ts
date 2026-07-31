export const MODEL_PRESET_LIST_TOOL_NAME = "list_node_model_presets";

export function appendModelPresetLookupHint(
  message: string,
  nodeId: string,
): string {
  return `${message}. Call ${MODEL_PRESET_LIST_TOOL_NAME} with node_id '${nodeId}' to list valid preset ids.`;
}
