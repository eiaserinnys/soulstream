export type PlannerInvalidationSource =
  | 'session_created'
  | 'session_updated'
  | 'session_deleted'
  | 'metadata_updated'
  | 'catalog'
  | 'folder'
  | 'custom_view'
  | 'replay'
  | 'page';

export type PlannerInvalidationCounters = Readonly<
  Record<PlannerInvalidationSource, number>
>;

export interface PlannerInvalidationKeys {
  daily: number;
  project: number;
  starred: number;
  runHistory: number;
  pageDetail: number;
}
const SOURCE_NAMES: readonly PlannerInvalidationSource[] = [
  'session_created',
  'session_updated',
  'session_deleted',
  'metadata_updated',
  'catalog',
  'folder',
  'custom_view',
  'replay',
  'page',
];

export function createPlannerInvalidationCounters(): PlannerInvalidationCounters {
  return Object.freeze(Object.fromEntries(
    SOURCE_NAMES.map((source) => [source, 0]),
  ) as Record<PlannerInvalidationSource, number>);
}

export function incrementPlannerInvalidation(
  counters: PlannerInvalidationCounters,
  source: PlannerInvalidationSource,
): PlannerInvalidationCounters {
  return Object.freeze({ ...counters, [source]: counters[source] + 1 });
}

export function plannerSourceForStreamEvent(
  eventType: string,
): PlannerInvalidationSource | null {
  switch (eventType) {
    case 'session_created':
    case 'session_updated':
    case 'session_deleted':
    case 'metadata_updated':
      return eventType;
    case 'catalog_updated':
      return 'catalog';
    case 'folder_updated':
      return 'folder';
    case 'custom_view_updated':
      return 'custom_view';
    case 'page_updated':
      return 'page';
    case 'replay_gap':
      return 'replay';
    default:
      return null;
  }
}

export function selectPlannerInvalidationKeys(
  counters: PlannerInvalidationCounters,
): PlannerInvalidationKeys {
  const pageCollections = key(counters, [
    'session_created',
    'session_deleted',
    'folder',
    'page',
    'replay',
  ]);
  return {
    daily: pageCollections,
    project: pageCollections,
    starred: key(counters, [
      'page',
      'replay',
      'folder',
      'session_created',
      'session_deleted',
    ]),
    runHistory: key(counters, ['session_created', 'session_deleted', 'replay']),
    pageDetail: key(counters, ['page', 'replay']),
  };
}

function key(
  counters: PlannerInvalidationCounters,
  sources: readonly PlannerInvalidationSource[],
): number {
  return sources.reduce((total, source) => total + counters[source], 0);
}
