import { expect } from "vitest";
import { requirePostgresBackendInCI } from "../../../packages/db-schema/scripts/postgres-test-policy.mjs";

requirePostgresBackendInCI(expect.getState().testPath ?? "");
