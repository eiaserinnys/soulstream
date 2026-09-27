import { describe, expect, it } from "vitest";

import {
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
} from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_retry_policy.js";
import { publicReasoningEffort } from "../../../orch-server-ts/src/runtime/live_session_serialization.js";
import {
  DELIVERY_NOTIFICATION_MAX_AGE_MS,
  DELIVERY_NOTIFICATION_MAX_ATTEMPTS,
} from "../../src/task/session_delivery_notification_policy.js";
import { REASONING_EFFORT_AUTO } from "../../src/task/session_effort_storage.js";

describe("worker and orchestrator session policy contract", () => {
  it("keeps delivery retry budgets identical", () => {
    expect(DELIVERY_NOTIFICATION_MAX_ATTEMPTS).toBe(DELIVERY_MAX_ATTEMPTS);
    expect(DELIVERY_NOTIFICATION_MAX_AGE_MS).toBe(DELIVERY_MAX_AGE_MS);
  });

  it("keeps the worker's internal auto marker private in session responses", () => {
    expect(publicReasoningEffort(REASONING_EFFORT_AUTO)).toBeNull();
  });
});
