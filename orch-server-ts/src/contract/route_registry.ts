import type { RouteInventoryFixture } from "./types.js";

export const ROUTE_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT", "WEBSOCKET"] as const;

export type RouteMethod = (typeof ROUTE_METHODS)[number];

export type RouteFamily =
  | "public_config"
  | "auth"
  | "control_plane"
  | "board_yjs_proxy"
  | "page_yjs"
  | "runbook"
  | "task_tree"
  | "dashboard_static"
  | "session"
  | "node_proxy"
  | "admin_or_user"
  | "catalog"
  | "asset"
  | "attachment"
  | "introspection"
  | "unknown";

export type RouteKey = `${RouteMethod} ${string}`;

export type RouteDefinition = {
  order: number;
  methods: RouteMethod[];
  path: string;
  name: string;
  authRequired: boolean;
  family: RouteFamily;
};

export type RouteRegistryEntry = {
  key: RouteKey;
  method: RouteMethod;
  path: string;
  name: string;
  order: number;
  authRequired: boolean;
  family: RouteFamily;
};

export type RouteRegistry = {
  routes: RouteDefinition[];
  entries: RouteRegistryEntry[];
  byKey: ReadonlyMap<RouteKey, RouteRegistryEntry>;
  byPath: ReadonlyMap<string, RouteRegistryEntry[]>;
  byMethod: ReadonlyMap<RouteMethod, RouteRegistryEntry[]>;
};

export type StaticBeforeDynamicHazard = {
  staticPath: string;
  dynamicPath: string;
};

export type StaticBeforeDynamicViolation = StaticBeforeDynamicHazard & {
  staticOrder: number;
  dynamicOrder: number;
};

export type StaticBeforeDynamicPriorityResult = {
  valid: boolean;
  hazards: StaticBeforeDynamicHazard[];
  violations: StaticBeforeDynamicViolation[];
};

export type PublicRouteAuthMatrixResult = {
  valid: boolean;
  publicRouteKeys: RouteKey[];
  missingExpectedPublicRouteKeys: RouteKey[];
  unexpectedPublicRouteKeys: RouteKey[];
  expectedPublicRoutesRequiringAuth: RouteKey[];
};

const ROUTE_METHOD_SET = new Set<string>(ROUTE_METHODS);

export const EXPECTED_PUBLIC_ROUTE_KEYS = [
  "GET /api/auth/config",
  "GET /api/auth/google",
  "GET /api/auth/google/callback",
  "GET /api/auth/status",
  "GET /api/config",
  "GET /api/health",
  "POST /api/auth/dev-login",
  "POST /api/auth/google/native",
  "POST /api/auth/logout",
  "WEBSOCKET /ws/node",
  "WEBSOCKET /yjs/page/{pageId}",
] as const satisfies readonly RouteKey[];

const KNOWN_STATIC_BEFORE_DYNAMIC_HAZARDS: StaticBeforeDynamicHazard[] = [
  {
    staticPath: "/api/sessions/{session_id}/events/viewport",
    dynamicPath: "/api/sessions/{session_id}/events",
  },
  {
    staticPath: "/api/runbooks/my-turn",
    dynamicPath: "/api/runbooks/{runbook_id}",
  },
  {
    staticPath: "/api/pages/daily",
    dynamicPath: "/api/pages/{pageId}",
  },
];

export function routeKey(method: RouteMethod, path: string): RouteKey {
  return `${method} ${path}` as RouteKey;
}

export function buildRouteRegistry(fixture: RouteInventoryFixture): RouteRegistry {
  const routes: RouteDefinition[] = fixture.routes.map((route) => ({
    order: route.order,
    methods: route.methods.map(toRouteMethod),
    path: route.path,
    name: route.name,
    authRequired: route.authRequired,
    family: classifyRouteFamily(route.path),
  }));

  const entries = routes.flatMap((route) =>
    route.methods.map((method) => ({
      key: routeKey(method, route.path),
      method,
      path: route.path,
      name: route.name,
      order: route.order,
      authRequired: route.authRequired,
      family: route.family,
    })),
  );

  return {
    routes,
    entries,
    byKey: indexFirstBy(entries, (entry) => entry.key),
    byPath: groupBy(entries, (entry) => entry.path),
    byMethod: groupBy(entries, (entry) => entry.method),
  };
}

type TypeScriptAdditiveRoute = Omit<RouteDefinition, "order"> & {
  beforePath?: string;
};

const TYPESCRIPT_ADDITIVE_ROUTES: readonly TypeScriptAdditiveRoute[] = [
  {
    methods: ["GET"],
    path: "/api/pages/search",
    name: "search_pages",
    authRequired: true,
    family: "page_yjs",
    beforePath: "/api/pages/{pageId}",
  },
  {
    methods: ["GET"],
    path: "/api/blocks/search",
    name: "search_blocks",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/blocks/{blockId}",
    name: "read_block",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/pages/{pageId}/backlinks",
    name: "list_page_backlinks",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/pages/{pageId}/session-defaults",
    name: "resolve_page_session_defaults",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["POST"],
    path: "/api/pages/block-transfers",
    name: "transfer_page_blocks",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/today",
    name: "read_today_planner",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/starred-tasks",
    name: "list_planner_starred_tasks",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/daily-history",
    name: "list_planner_daily_history",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/projects/{pageId}",
    name: "read_project_planner",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/projects/{pageId}/tasks",
    name: "list_project_planner_tasks",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/projects/{pageId}/documents",
    name: "list_project_planner_documents",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["GET"],
    path: "/api/planner/tasks/{pageId}/runs",
    name: "list_planner_task_runs",
    authRequired: true,
    family: "page_yjs",
  },
  {
    methods: ["POST"],
    path: "/api/sessions/{session_id}/review/acknowledge",
    name: "acknowledge_session_review",
    authRequired: true,
    family: "session",
  },
  {
    methods: ["POST"],
    path: "/api/runbooks",
    name: "create_runbook",
    authRequired: true,
    family: "runbook",
    beforePath: "/api/runbooks/{runbook_id}",
  },
];

/**
 * Python 이행 fixture에 아직 존재하지 않는 TS 런타임 전용 additive route까지 포함한다.
 * Python 기준선 자체를 변조하지 않으면서 route coverage가 실제 TS 운영 표면을 검증한다.
 */
export function buildRuntimeRouteRegistry(fixture: RouteInventoryFixture): RouteRegistry {
  const baseline = buildRouteRegistry(fixture);
  const nextOrder = baseline.routes.reduce(
    (highest, route) => Math.max(highest, route.order),
    -1,
  ) + 1;
  const routes = [
    ...baseline.routes,
    ...TYPESCRIPT_ADDITIVE_ROUTES.map(({ beforePath, ...route }, index) => ({
      ...route,
      order: beforePath === undefined
        ? nextOrder + index
        : (baseline.routes.find((entry) => entry.path === beforePath)?.order ?? nextOrder) - 0.5,
    })),
  ];
  return buildRouteRegistry({
    ...fixture,
    routes: routes.map(({ family: _family, ...route }) => route),
  });
}

export function getRouteByKey(
  registry: RouteRegistry,
  method: RouteMethod,
  path: string,
): RouteRegistryEntry | undefined {
  return registry.byKey.get(routeKey(method, path));
}

export function getRoutesByPath(registry: RouteRegistry, path: string): RouteRegistryEntry[] {
  return registry.byPath.get(path) ?? [];
}

export function getRoutesByMethod(
  registry: RouteRegistry,
  method: RouteMethod,
): RouteRegistryEntry[] {
  return registry.byMethod.get(method) ?? [];
}

export function findDuplicateRouteKeys(registry: RouteRegistry): RouteKey[] {
  const counts = new Map<RouteKey, number>();
  for (const entry of registry.entries) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}

export function assertNoDuplicateRouteKeys(registry: RouteRegistry): void {
  const duplicates = findDuplicateRouteKeys(registry);
  if (duplicates.length > 0) {
    throw new Error(`duplicate route keys: ${duplicates.join(", ")}`);
  }
}

export function validateStaticBeforeDynamicPriority(
  registry: RouteRegistry,
): StaticBeforeDynamicPriorityResult {
  const hazards = KNOWN_STATIC_BEFORE_DYNAMIC_HAZARDS.filter((hazard) => {
    const staticOrder = orderForPath(registry, hazard.staticPath);
    const dynamicOrder = orderForPath(registry, hazard.dynamicPath);
    return staticOrder !== undefined && dynamicOrder !== undefined && staticOrder < dynamicOrder;
  });

  const violationByPair = new Map<string, StaticBeforeDynamicViolation>();
  for (const violation of knownStaticBeforeDynamicViolations(registry)) {
    violationByPair.set(routePairKey(violation), violation);
  }
  for (const violation of genericStaticBeforeDynamicViolations(registry)) {
    violationByPair.set(routePairKey(violation), violation);
  }

  const violations = [...violationByPair.values()].sort((left, right) =>
    routePairKey(left).localeCompare(routePairKey(right)),
  );

  return {
    valid: violations.length === 0,
    hazards,
    violations,
  };
}

export function validatePublicRouteAuthMatrix(
  registry: RouteRegistry,
  expectedPublicRouteKeys: readonly RouteKey[] = EXPECTED_PUBLIC_ROUTE_KEYS,
): PublicRouteAuthMatrixResult {
  const publicRouteKeys = registry.entries
    .filter((entry) => !entry.authRequired)
    .map((entry) => entry.key)
    .sort();
  const publicRouteSet = new Set(publicRouteKeys);
  const expectedSet = new Set(expectedPublicRouteKeys);

  const missingExpectedPublicRouteKeys = [...expectedPublicRouteKeys]
    .filter((key) => !publicRouteSet.has(key))
    .sort();
  const unexpectedPublicRouteKeys = publicRouteKeys
    .filter((key) => !expectedSet.has(key))
    .sort();
  const expectedPublicRoutesRequiringAuth = [...expectedPublicRouteKeys]
    .filter((key) => registry.byKey.get(key)?.authRequired === true)
    .sort();

  return {
    valid:
      missingExpectedPublicRouteKeys.length === 0 &&
      unexpectedPublicRouteKeys.length === 0 &&
      expectedPublicRoutesRequiringAuth.length === 0,
    publicRouteKeys,
    missingExpectedPublicRouteKeys,
    unexpectedPublicRouteKeys,
    expectedPublicRoutesRequiringAuth,
  };
}

export function classifyRouteFamily(path: string): RouteFamily {
  if (path === "/" || path.startsWith("/assets/")) return "dashboard_static";
  if (path === "/api/health" || path === "/api/config") return "public_config";
  if (isControlPlanePath(path)) return "control_plane";
  if (path.startsWith("/api/auth/") || path === "/api/auth/token") return "auth";
  if (path.includes("/claude-auth/") || path.includes("/provider-usage")) return "auth";
  if (path.startsWith("/api/board-yjs/")) return "board_yjs_proxy";
  if (
    path === "/api/pages" ||
    path.startsWith("/api/pages/") ||
    path.startsWith("/api/blocks/") ||
    path.startsWith("/api/planner/") ||
    path.startsWith("/api/page-yjs/") ||
    path.startsWith("/yjs/page/")
  ) {
    return "page_yjs";
  }
  if (path.startsWith("/api/runbooks/")) return "runbook";
  if (path.startsWith("/api/tasks")) return "task_tree";
  if (path.startsWith("/api/sessions")) return "session";
  if (path.startsWith("/api/nodes/")) return "node_proxy";
  if (path.startsWith("/api/config/settings") || path.startsWith("/api/dashboard/config")) {
    return "node_proxy";
  }
  if (path.startsWith("/api/admin/") || path.startsWith("/api/user/")) return "admin_or_user";
  if (
    path.startsWith("/api/folders") ||
    path.startsWith("/api/board-items") ||
    path.startsWith("/api/markdown-documents") ||
    path.startsWith("/api/custom-views")
  ) {
    return "catalog";
  }
  if (path.startsWith("/api/board/") || path.startsWith("/api/board-containers/")) {
    return "asset";
  }
  if (path.startsWith("/api/attachments/")) return "attachment";
  if (path.startsWith("/cogito/") || path.startsWith("/api/atom/")) return "introspection";
  return "unknown";
}

export function isLowRiskRouteEntry(route: Pick<RouteRegistryEntry, "family">): boolean {
  return route.family === "public_config" || route.family === "dashboard_static";
}

function toRouteMethod(method: string): RouteMethod {
  if (!ROUTE_METHOD_SET.has(method)) {
    throw new Error(`unknown route method in contract fixture: ${method}`);
  }
  return method as RouteMethod;
}

function isControlPlanePath(path: string): boolean {
  if (
    path === "/ws/node" ||
    path === "/api/status" ||
    path === "/api/nodes" ||
    path === "/api/nodes/stream" ||
    path === "/api/sessions/stream" ||
    path === "/api/tasks/stream" ||
    path === "/api/execute"
  ) {
    return true;
  }

  return /^\/api\/sessions\/\{session_id\}\/(events|intervene|message|interrupt|review|background-tasks|schedules|respond|tool-approvals|realtime)(\/|$)/.test(
    path,
  );
}

function knownStaticBeforeDynamicViolations(
  registry: RouteRegistry,
): StaticBeforeDynamicViolation[] {
  return KNOWN_STATIC_BEFORE_DYNAMIC_HAZARDS.flatMap((hazard) => {
    const staticOrder = orderForPath(registry, hazard.staticPath);
    const dynamicOrder = orderForPath(registry, hazard.dynamicPath);
    if (staticOrder === undefined || dynamicOrder === undefined || staticOrder < dynamicOrder) {
      return [];
    }
    return [
      {
        ...hazard,
        staticOrder,
        dynamicOrder,
      },
    ];
  });
}

function genericStaticBeforeDynamicViolations(
  registry: RouteRegistry,
): StaticBeforeDynamicViolation[] {
  const violations: StaticBeforeDynamicViolation[] = [];
  for (const staticRoute of registry.routes) {
    for (const dynamicRoute of registry.routes) {
      if (staticRoute.path === dynamicRoute.path) continue;
      if (!hasSharedMethod(staticRoute, dynamicRoute)) continue;
      if (!couldShadow(dynamicRoute.path, staticRoute.path)) continue;
      if (staticRoute.order > dynamicRoute.order) {
        violations.push({
          staticPath: staticRoute.path,
          dynamicPath: dynamicRoute.path,
          staticOrder: staticRoute.order,
          dynamicOrder: dynamicRoute.order,
        });
      }
    }
  }
  return violations;
}

function couldShadow(dynamicPath: string, staticPath: string): boolean {
  const dynamicSegments = splitRoutePath(dynamicPath);
  const staticSegments = splitRoutePath(staticPath);
  if (dynamicSegments.length !== staticSegments.length) return false;
  if (dynamicSegmentCount(dynamicSegments) <= dynamicSegmentCount(staticSegments)) return false;

  return dynamicSegments.every((segment, index) => {
    return isDynamicSegment(segment) || segment === staticSegments[index];
  });
}

function splitRoutePath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function dynamicSegmentCount(segments: string[]): number {
  return segments.filter(isDynamicSegment).length;
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function hasSharedMethod(left: RouteDefinition, right: RouteDefinition): boolean {
  const rightMethods = new Set(right.methods);
  return left.methods.some((method) => rightMethods.has(method));
}

function orderForPath(registry: RouteRegistry, path: string): number | undefined {
  return registry.routes.find((route) => route.path === path)?.order;
}

function routePairKey(pair: StaticBeforeDynamicHazard): string {
  return `${pair.staticPath} -> ${pair.dynamicPath}`;
}

function indexFirstBy<K, V>(items: V[], keyFor: (item: V) => K): ReadonlyMap<K, V> {
  const result = new Map<K, V>();
  for (const item of items) {
    const key = keyFor(item);
    if (!result.has(key)) result.set(key, item);
  }
  return result;
}

function groupBy<K, V>(items: V[], keyFor: (item: V) => K): ReadonlyMap<K, V[]> {
  const result = new Map<K, V[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = result.get(key);
    if (group) {
      group.push(item);
    } else {
      result.set(key, [item]);
    }
  }
  return result;
}
