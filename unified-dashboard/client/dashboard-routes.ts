import {
  buildSessionSearchUrl,
  parseSessionSearchIntent,
} from "@soulstream/search-contract";

export const MAIN_DASHBOARD_PATH = "/";

function isPathFamily(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function isRetiredDashboardPathname(pathname: string): boolean {
  return isPathFamily(pathname, "/v1")
    || isPathFamily(pathname, "/v2")
    || isPathFamily(pathname, "/v3");
}

export function redirectRetiredDashboardPathname(
  pathname: string,
  history: Pick<History, "replaceState" | "state">,
  updatePathname: (pathname: string) => void,
  currentUrl: string = pathname,
): boolean {
  if (!isRetiredDashboardPathname(pathname)) return false;

  const legacyIntent = isPathFamily(pathname, "/v1")
    ? parseSessionSearchIntent(currentUrl)
    : null;
  let target = MAIN_DASHBOARD_PATH;
  if (legacyIntent) {
    const source = new URL(currentUrl, "https://dashboard.invalid");
    const canonicalIntent = new URL(
      buildSessionSearchUrl(legacyIntent),
      "https://dashboard.invalid",
    );
    const destination = new URL(MAIN_DASHBOARD_PATH, source);
    for (const [key, value] of source.searchParams) {
      if (key === "session" || key === "event") continue;
      destination.searchParams.append(key, value);
    }
    for (const [key, value] of canonicalIntent.searchParams) {
      destination.searchParams.set(key, value);
    }
    target = `${destination.pathname}${destination.search}`;
  }
  history.replaceState(history.state, "", target);
  updatePathname(new URL(target, "https://dashboard.invalid").pathname);
  return true;
}
