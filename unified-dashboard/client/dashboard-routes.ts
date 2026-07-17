export const MAIN_DASHBOARD_PATH = "/";
export const LEGACY_DASHBOARD_PATH = "/v1";

function isPathFamily(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function isRetiredDashboardPathname(pathname: string): boolean {
  return isPathFamily(pathname, "/v2") || isPathFamily(pathname, "/v3");
}

export function redirectRetiredDashboardPathname(
  pathname: string,
  history: Pick<History, "replaceState" | "state">,
  updatePathname: (pathname: string) => void,
): boolean {
  if (!isRetiredDashboardPathname(pathname)) return false;

  history.replaceState(history.state, "", MAIN_DASHBOARD_PATH);
  updatePathname(MAIN_DASHBOARD_PATH);
  return true;
}

export function resolveOrchestratorDashboardVersion(
  pathname: string,
): "v1" | "v3" {
  return isPathFamily(pathname, LEGACY_DASHBOARD_PATH) ? "v1" : "v3";
}
