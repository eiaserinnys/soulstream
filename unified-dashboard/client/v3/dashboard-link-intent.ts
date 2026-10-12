import { parseSessionSearchIntent, removeSessionSearchIntent } from "@soulstream/search-contract";
import { classifyInternalLink, type InternalLinkTarget } from "@seosoyoung/soul-ui";

export type DashboardLinkTarget = Exclude<InternalLinkTarget, { kind: "attachment" }>;

export interface DashboardLinkIntent {
  target: DashboardLinkTarget;
  identity: string;
  legacy: boolean;
}

export function readDashboardLinkIntent(
  location: Pick<Location, "pathname" | "search" | "hash">,
  internalOrigins: readonly string[],
): DashboardLinkIntent | null {
  const identity = `${location.pathname}${location.search}${location.hash}`;
  const target = classifyInternalLink(`${location.pathname}${location.search}`, internalOrigins);
  if (target && target.kind !== "attachment") {
    return { target, identity, legacy: false };
  }

  if (/^#\/feed\//.test(location.hash)) {
    const legacySession = parseSessionSearchIntent(identity);
    if (legacySession) {
      return {
        target: {
          kind: "session",
          sessionId: legacySession.sessionId,
          ...(legacySession.eventId === undefined ? {} : { eventId: legacySession.eventId }),
        },
        identity,
        legacy: true,
      };
    }
  }
  return null;
}

export function consumeDashboardLinkIntent(
  href: string,
  intent: DashboardLinkIntent,
): string {
  if (intent.legacy) return removeSessionSearchIntent(href);

  const url = new URL(href, "https://dashboard-link-intent.invalid");
  if (intent.target.kind === "session") {
    url.searchParams.delete("session");
    url.searchParams.delete("event");
  } else {
    url.searchParams.delete(intent.target.kind);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
