import type { LiveAuthenticatedUserResolvers } from "../runtime/live_authenticated_user_resolver.js";

import { RecurringJobScheduler } from "./scheduler.js";
import type { RecurringJobRouteActorResolver } from "./recurring_job_routes.js";
import type { RecurringJobService } from "./service.js";
import type { RecurringJobRepository } from "./types.js";

export type ProductionRecurringJobWiringOptions = {
  readonly service: RecurringJobService;
  readonly repository: RecurringJobRepository;
  readonly authenticatedUserResolvers: Pick<
    LiveAuthenticatedUserResolvers,
    "resolveEmail" | "resolveCallerInfo"
  >;
  readonly authBearerToken: string;
  readonly onError: (error: unknown, operation: string) => void;
};

export function createProductionRecurringJobWiring(
  options: ProductionRecurringJobWiringOptions,
) {
  const { service } = options;
  const scheduler = new RecurringJobScheduler({
    service,
    repository: options.repository,
    onError: options.onError,
  });
  const resolveActor: RecurringJobRouteActorResolver = async (request) => {
    const email = await options.authenticatedUserResolvers.resolveEmail(request);
    if (!email?.trim()) return null;
    const callerInfo = await options.authenticatedUserResolvers.resolveCallerInfo(
      request,
      null,
      "",
    );
    const source = callerInfo.source === "soul-app" ? "soul-app" : "browser";
    return {
      ownerEmail: email,
      actorId: email,
      callerInfo,
      source,
    };
  };

  return {
    scheduler,
    routes: {
      service,
      resolveActor,
    },
    hostRoutes: {
      service,
      authBearerToken: options.authBearerToken,
    },
  };
}
