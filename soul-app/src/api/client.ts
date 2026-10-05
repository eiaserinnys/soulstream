import { createApiRequestContext, type ApiRequestContextOptions } from './clientCore';
import { createAuthEndpoints } from './authEndpoints';
import { createCatalogEndpoints } from './catalogEndpoints';
import { createSessionEndpoints } from './sessionEndpoints';
import { createNodeEndpoints } from './nodeEndpoints';
import { createPushEndpoints } from './pushEndpoints';
import { createRealtimeEndpoints } from './realtimeEndpoints';
import { createAttachmentEndpoints } from './attachmentEndpoints';
import { createAtomEndpoints } from './atomEndpoints';
import { createStreamEndpoints } from './streamEndpoints';
import { createPreferencesEndpoints } from './preferencesEndpoints';
import { createPlannerEndpoints } from './plannerEndpoints';
import { createPageEndpoints } from './pageEndpoints';
import { createBoardItemEndpoints } from './boardItemEndpoints';
import { createPlannerMutationPort } from './plannerMutationPort';
import { createSearchEndpoints } from './searchEndpoints';
import { createSettingsEndpoints } from './settingsEndpoints';
import { createUiEventsEndpoints } from './uiEventsEndpoints';
import { createRecurringJobsEndpoints } from './recurringJobsEndpoints';
import { createCardEndpoints } from './cardEndpoints';
import { createOwnedAgentsEndpoints } from './ownedAgentsEndpoints';
export type {
  RecurringJobDto,
  RecurringJobRunDto,
  RecurringJobWrite,
} from './recurringJobsEndpoints';

export type {
  CatalogResponse,
  HistoricalMessage,
  MessagesResponse,
  ToolTraceResponse,
} from './clientTypes';
export type {
  SessionMessageSearchParams,
  SessionMessageSearchResponse,
  SessionMessageSearchResult,
  SessionMessageSearchStatus,
  SessionSearchProjection,
  SessionSearchFilters,
  SearchMatchSource,
  SearchNavigationResult,
  SessionMetadataSearchPage,
  SessionMetadataSearchParams,
} from './searchEndpoints';
export type { FeedPage } from './feedPage';
export type {
  UiEventEntry,
  UiEventTarget,
  UiEventTargetKind,
  UiEventsBatch,
  UiEventsConfig,
  UiEventsPostResult,
  UiEventWire,
} from './uiEventsEndpoints';

/**
 * Soulstream / soul-server 공통 API 클라이언트.
 *
 * Public facade는 `src/api/client.ts`에 고정한다. endpoint 구현은 domain별 builder가
 * 맡고, 호출자는 기존처럼 `createApiClient(baseUrl)`와 `ApiClient` 타입만 사용한다.
 */
export function createApiClient(baseUrl: string, options?: ApiRequestContextOptions) {
  const context = createApiRequestContext(baseUrl, options);
  const endpoints = {
    ...createAuthEndpoints(context),
    ...createCatalogEndpoints(context),
    ...createSessionEndpoints(context),
    ...createNodeEndpoints(context),
    ...createPushEndpoints(context),
    ...createRealtimeEndpoints(context),
    ...createAttachmentEndpoints(context),
    ...createAtomEndpoints(context),
    ...createStreamEndpoints(context),
    ...createPreferencesEndpoints(context),
    ...createPlannerEndpoints(context),
    ...createPageEndpoints(context),
    ...createBoardItemEndpoints(context),
    ...createSearchEndpoints(context),
    ...createSettingsEndpoints(context),
    ...createUiEventsEndpoints(context),
    ...createRecurringJobsEndpoints(context),
    ...createCardEndpoints(context),
    ...createOwnedAgentsEndpoints(context),
  };
  return {
    ...endpoints,
    plannerMutations: createPlannerMutationPort(endpoints),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
