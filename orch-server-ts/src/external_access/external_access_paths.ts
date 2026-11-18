/**
 * Access link paths carry the link key in the URL path (design 2.7). Every
 * place that writes a request path to a log goes through this module so a key
 * never reaches the log, matched route or not.
 */

export const EXTERNAL_ACCESS_PREFIX = "/x";
export const EXTERNAL_ACCESS_REDACTED_LOG_PATH = "/x/:redacted";

/** Fastify route templates of the public `/x` surface (design 2.7, 3.2). */
export const externalAccessRouteTemplates = [
  "/x/:key",
  "/x/:key/messages",
  "/x/:key/messages/:requestId",
  "/x/:key/history",
  "/x/:key/stop",
  "/x/:key/hook",
] as const;

const externalAccessRouteTemplateSet: ReadonlySet<string> = new Set(
  externalAccessRouteTemplates,
);

export function isExternalAccessRequestPath(pathname: string): boolean {
  return pathname === EXTERNAL_ACCESS_PREFIX
    || pathname.startsWith(`${EXTERNAL_ACCESS_PREFIX}/`);
}

/**
 * The matched template when it is one of the five public routes, otherwise the
 * fixed marker. A request that matched nothing never reports its real path.
 */
export function externalAccessLogPath(
  routeTemplate: string | undefined,
): string {
  return routeTemplate !== undefined
    && externalAccessRouteTemplateSet.has(routeTemplate)
    ? routeTemplate
    : EXTERNAL_ACCESS_REDACTED_LOG_PATH;
}
