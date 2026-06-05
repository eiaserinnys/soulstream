export const DASHBOARD_CACHE_BUST_PARAM = "soul_desktop_cache_bust";

export function buildDashboardCacheBustValue(
  version = __SOUL_DESKTOP_VERSION__,
): string {
  return `v${version}`;
}
export function toCacheBustedDashboardUrl(
  url: string,
  version = __SOUL_DESKTOP_VERSION__,
): string {
  const next = new URL(url);
  next.searchParams.set(
    DASHBOARD_CACHE_BUST_PARAM,
    buildDashboardCacheBustValue(version),
  );
  return next.toString();
}
