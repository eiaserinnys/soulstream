/** Query that the native "서버 주소 설정…" menu adds to the bundled app URL. */
const SETTINGS_VIEW = "settings";

export function isSettingsViewRequested(search: string): boolean {
  return new URLSearchParams(search).get("view") === SETTINGS_VIEW;
}

export type StartupAction = "setup" | "settings" | "navigate" | "wait-for-update";

/**
 * Where the bundled app goes at startup.
 * `view=settings` (from the native menu) opens Settings even though a server URL
 * is saved, and never jumps to the saved server on its own.
 */
export function decideStartup(input: {
  savedUrl: string | null;
  search: string;
  updateAvailable: boolean;
}): StartupAction {
  if (!input.savedUrl) return "setup";
  if (isSettingsViewRequested(input.search)) return "settings";
  return input.updateAvailable ? "wait-for-update" : "navigate";
}
