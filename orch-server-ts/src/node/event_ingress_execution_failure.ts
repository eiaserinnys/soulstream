import type { EventSessionEffect } from "./event_ingress_contract.js";
import {
  assertExactKeys,
  isoTimestamp,
  nonEmptyString,
  positiveInteger,
} from "./event_ingress_validation.js";

type ExecutionFailureEffect = Extract<
  EventSessionEffect,
  { kind: "execution_fail" | "execution_expire_dead_owner" }
>;

export function parseExecutionFailureEffect(
  value: Record<string, unknown>,
  field: string,
): ExecutionFailureEffect | null {
  if (value.kind === "execution_fail") {
    assertExactKeys(
      value,
      ["kind", "ownership_generation", "failure_reason", "updated_at"],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(
        value.ownership_generation,
        `${field}.ownership_generation`,
      ),
      failure_reason: nonEmptyString(value.failure_reason, `${field}.failure_reason`),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind !== "execution_expire_dead_owner") return null;
  assertExactKeys(
    value,
    [
      "kind", "ownership_generation", "pid", "start_identity",
      "failure_reason", "updated_at",
    ],
    field,
  );
  return {
    kind: value.kind,
    ownership_generation: positiveInteger(
      value.ownership_generation,
      `${field}.ownership_generation`,
    ),
    pid: positiveInteger(value.pid, `${field}.pid`),
    start_identity: nonEmptyString(value.start_identity, `${field}.start_identity`),
    failure_reason: nonEmptyString(value.failure_reason, `${field}.failure_reason`),
    updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
  };
}
