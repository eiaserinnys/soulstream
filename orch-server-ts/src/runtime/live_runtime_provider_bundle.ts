import type { FastifyRequest } from "fastify";

import { ModelPresetAvailabilityService } from "../model/model_preset_availability.js";
import {
  createSessionReviewAcknowledgeFallback,
  type SessionReviewAcknowledgeRepository,
} from "../session/session_review_acknowledge_fallback.js";
import type { SessionCreateLifecycle } from "../session/session_create_lifecycle.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { SessionStreamEventFilter } from "../session/session_stream_event_filter.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import type { OrchestratorRuntimeServices } from "./composition.js";
import type { LiveCallerInfoResolver } from "./live_authenticated_user_resolver.js";
import { LiveProviderFactoryError } from "./live_provider_factory_inventory.js";

export type LiveRuntimeProviderBundle = {
  readonly boardYjsHostProxyRoutes:
    OrchestratorRuntimeServices["routeOptions"]["boardYjsHostProxyRoutes"];
  readonly nodeSnapshotRoutes:
    OrchestratorRuntimeServices["routeOptions"]["nodeSnapshotRoutes"];
  readonly nodeWsRoute: OrchestratorRuntimeServices["routeOptions"]["nodeWsRoute"];
  readonly sessionActionCommandRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionActionCommandRoutes"]
  >;
  readonly sessionBackgroundScheduleRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionBackgroundScheduleRoutes"]
  >;
  readonly sessionCommandRoutes:
    OrchestratorRuntimeServices["routeOptions"]["sessionCommandRoutes"];
  readonly sessionHistoryRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionHistoryRoutes"]
  >;
  readonly sessionSnapshotRoutes:
    OrchestratorRuntimeServices["routeOptions"]["sessionSnapshotRoutes"];
  readonly sseReplayRoutes: OrchestratorRuntimeServices["routeOptions"]["sseReplayRoutes"];
};

export function buildLiveRuntimeProviderBundle(
  services: OrchestratorRuntimeServices,
  accessProvider: SessionResourceAccessProvider,
  sessionStreamEventFilter: SessionStreamEventFilter,
  resolveCallerInfo: LiveCallerInfoResolver,
  sessionCreateLifecycle: SessionCreateLifecycle,
  sessionReviewRepository: SessionReviewAcknowledgeRepository,
  modelPresetAvailability: ModelPresetAvailabilityService,
  sessionSnapshotRoutes:
    OrchestratorRuntimeServices["routeOptions"]["sessionSnapshotRoutes"],
  loadSessionSnapshot: (request: FastifyRequest) => Promise<SessionStreamSnapshot>,
): LiveRuntimeProviderBundle {
  const sessionHistoryRoutes = requireRuntimeRouteOption(
    services.routeOptions.sessionHistoryRoutes,
    "session.history",
    "runtime.sessionHistoryProvider",
  );
  return {
    boardYjsHostProxyRoutes: services.routeOptions.boardYjsHostProxyRoutes,
    nodeSnapshotRoutes: services.routeOptions.nodeSnapshotRoutes,
    nodeWsRoute: services.routeOptions.nodeWsRoute,
    sessionActionCommandRoutes: {
      ...requireRuntimeRouteOption(
        services.routeOptions.sessionActionCommandRoutes,
        "session.actions",
        "runtime",
      ),
      reviewAcknowledgeFallback: createSessionReviewAcknowledgeFallback({
        repository: sessionReviewRepository,
        broadcaster: services.sessionBroadcaster,
      }),
      resolveCallerInfo: (request, bodyCallerInfo, targetSessionId) =>
        resolveCallerInfo(
          request,
          bodyCallerInfo,
          services.registry.findSessionOwner(targetSessionId)?.nodeId ?? "",
        ),
    },
    sessionBackgroundScheduleRoutes: requireRuntimeRouteOption(
      services.routeOptions.sessionBackgroundScheduleRoutes,
      "session.background-schedule",
      "runtime",
    ),
    sessionCommandRoutes: {
      ...services.routeOptions.sessionCommandRoutes,
      createSessionLifecycle: sessionCreateLifecycle,
      modelPresetAvailability,
    },
    sessionHistoryRoutes: { ...sessionHistoryRoutes, accessProvider },
    sessionSnapshotRoutes,
    sseReplayRoutes: {
      ...services.routeOptions.sseReplayRoutes,
      session: {
        ...services.routeOptions.sseReplayRoutes.session,
        loadSnapshot: loadSessionSnapshot,
        filterEvent: sessionStreamEventFilter,
      },
    },
  };
}

function requireRuntimeRouteOption<T>(
  value: T | undefined,
  owner: string,
  path: string,
): T {
  if (value !== undefined) return value;
  throw new LiveProviderFactoryError([
    {
      owner,
      path,
      status: "implemented",
      source: "createOrchestratorRuntimeServices",
      notes:
        "Runtime service did not expose a route option marked implemented in the live provider inventory.",
    },
  ]);
}
