export type LiveProviderWiringStatus = "implemented" | "stub" | "blocked";

export type LiveProviderWiringCompositionOwner =
  | "live-provider-factory"
  | "production-composition";

export type LiveProviderCutoverRisk = "low" | "medium" | "high";

export type LiveProviderDependency =
  | "auth"
  | "db"
  | "env"
  | "filesystem"
  | "http"
  | "jwt"
  | "node_http"
  | "oauth"
  | "r2"
  | "runtime"
  | "session_registry"
  | "sse"
  | "websocket";

export type LiveProviderWiringInventoryEntry = {
  readonly owner: string;
  readonly path: string;
  readonly compositionOwner: LiveProviderWiringCompositionOwner;
  readonly status: LiveProviderWiringStatus;
  readonly source: string;
  readonly dependencies: readonly LiveProviderDependency[];
  readonly cutoverRisk: LiveProviderCutoverRisk;
  readonly notes: string;
};

export type LiveProviderPath = {
  readonly owner: string;
  readonly path: string;
};

export { liveProviderWiringInventory } from "./provider_wiring_inventory_data.js";
