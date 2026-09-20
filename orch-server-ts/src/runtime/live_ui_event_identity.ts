import type { FastifyRequest } from "fastify";

import type { UiEventIdentity, UiEventIdentityResolver }
  from "../ui-events/ui_event_routes.js";
import type { LiveCallerInfoResolver } from "./live_authenticated_user_resolver.js";

export type CreateLiveUiEventIdentityResolverOptions = {
  readonly resolveCallerInfo: LiveCallerInfoResolver;
};

/**
 * UI 사용 로그의 신원은 **자격증명에서만** 나온다.
 *
 * `resolveCallerInfo`는 쿠키를 `browser`, Bearer를 `soul-app`으로 확정하는
 * 기존 보안 경계다(`live_authenticated_user_resolver.ts`). 본문이 이것을 덮을 수
 * 없으므로 여기서도 본문 callerInfo를 넘기지 않는다(`null`).
 *
 * 인증되지 않은 요청은 이메일이 없어 `null`이 된다 — fail-closed.
 */
export function createLiveUiEventIdentityResolver(
  options: CreateLiveUiEventIdentityResolverOptions,
): UiEventIdentityResolver {
  return async (request: FastifyRequest): Promise<UiEventIdentity | null> => {
    const callerInfo = await options.resolveCallerInfo(request, null, "");
    const source = callerInfo.source;
    if (source !== "browser" && source !== "soul-app") return null;
    const email = typeof callerInfo.email === "string" && callerInfo.email.length > 0
      ? callerInfo.email
      : undefined;
    if (email === undefined) return null;
    return { email, clientKind: source };
  };
}
