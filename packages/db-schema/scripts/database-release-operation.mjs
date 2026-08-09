function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for database release`);
  return value;
}

export function classifyDatabaseOperation(inventory) {
  const count = Number(inventory.object_count ?? (
    Number(inventory.relation_count) + Number(inventory.routine_count)
    + Number(inventory.type_count) + Number(inventory.ledger_count)
  ));
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("database object inventory is invalid");
  }
  return count === 0 ? "fresh_install" : "upgrade";
}

export async function discoverDatabaseOperation(context, existing = null) {
  const inventory = await context.inventoryRead();
  const observedOperation = classifyDatabaseOperation(inventory);
  const operation = existing?.operation ?? observedOperation;
  const completedFreshInstall = existing?.operation === "fresh_install"
    && ["apply_started", "apply_failed", "sql_applied", "subphase_started",
      "subphase_complete", "applied", "applied_reconciled", "verified"]
      .includes(existing.status);
  if (observedOperation !== operation && !completedFreshInstall) {
    throw new Error(`OPERATION_MISMATCH: expected ${operation}, got ${observedOperation}`);
  }
  const expected = (
    context.env.HANIEL_EXPECTED_DATABASE_OPERATION
    ?? context.env.HANIEL_DATABASE_OPERATION
  )?.trim();
  if (expected && expected !== operation) {
    throw new Error(`OPERATION_MISMATCH: expected ${expected}, got ${operation}`);
  }
  return { inventory, operation };
}

export async function probeDatabaseOperation(context, success) {
  const { operation } = await discoverDatabaseOperation(context);
  return success(context.env, {
    operation,
    phase: "probe",
    journalPath: null,
    status: "probed",
    extra: {
      target_head: required(context.env, "HANIEL_TARGET_HEAD"),
      manifest_digest: required(context.env, "HANIEL_MANIFEST_DIGEST"),
    },
  });
}
