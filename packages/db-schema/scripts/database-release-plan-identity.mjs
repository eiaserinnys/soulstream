import { fingerprintInventory } from "./database-release-inventory.mjs";

export function migrationIdentity(item) {
  return {
    id: item.id ?? item.migration_id,
    checksum: item.sha256 ?? item.checksum,
  };
}

function ledgerIdentity(item) {
  return {
    migration_id: item.migration_id,
    checksum: item.checksum,
    release_id: item.release_id,
    ordinal: Number(item.ordinal),
    applied_kind: item.applied_kind ?? null,
  };
}

export function planIdentity(plan) {
  return {
    bootstrap: (plan.bootstrap ?? []).map(migrationIdentity),
    pending: plan.pending.map(migrationIdentity),
    ledger: (plan.ledger ?? []).map(ledgerIdentity),
  };
}

export function inventoryObjectCount(inventory) {
  return Number(inventory.object_count ?? (
    Number(inventory.relation_count) + Number(inventory.routine_count)
    + Number(inventory.type_count) + Number(inventory.ledger_count)
  ));
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertUnchangedReleasePlanAndInventory(journal, plan, inventory) {
  const expectedPlan = planIdentity(plan);
  const bootstrap = expectedPlan.bootstrap;
  const pending = expectedPlan.pending;
  if (
    journal.pre_schema_fingerprint !== fingerprintInventory(inventory)
    || journal.pre_object_count !== inventoryObjectCount(inventory)
    || !sameJson(journal.bootstrap_migrations, bootstrap)
    || !sameJson(journal.pending_migrations, pending)
    || !sameJson(journal.planned_migrations, [...bootstrap, ...pending])
    || !sameJson(journal.pre_migration_plan, expectedPlan)
  ) {
    throw new Error("JOURNAL_GATE_FAILED: migration plan or database inventory changed");
  }
}

export function assertUnchangedZeroEffectPreflight(journal, plan, inventory) {
  const history = journal.history;
  if (
    journal.revision !== 1
    || journal.status !== "preflight_complete"
    || journal.last_committed_phase !== "preflight"
    || journal.failed_operation !== null
    || journal.apply_started_at !== null
    || journal.apply_committed_at !== null
    || journal.quiescence_receipt_digest !== null
    || journal.quiescence_owner_instance !== null
    || journal.quiescence_nonce !== null
    || !Array.isArray(journal.completed_subphases)
    || journal.completed_subphases.length !== 0
    || !Array.isArray(journal.applied_ledger)
    || journal.applied_ledger.length !== 0
    || journal.error !== null
    || !Array.isArray(history)
    || history.length !== 1
    || history[0].phase !== "preflight"
    || history[0].status !== "preflight_complete"
    || typeof history[0].occurred_at !== "string"
    || journal.updated_at !== history[0].occurred_at
  ) {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: preflight journal has effects or unknown fields");
  }
  try {
    assertUnchangedReleasePlanAndInventory(journal, plan, inventory);
  } catch {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: preflight plan or inventory changed");
  }
}
