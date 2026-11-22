import type { GlobalSetupContext } from "vitest/node";

import { startPostgresTestContainer } from "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import { decidePostgresTests } from "../../../packages/db-schema/scripts/postgres-test-policy.mjs";

declare module "vitest" {
  interface ProvidedContext {
    sharedPostgresTestUrl?: string;
  }
}

export default function setup({ provide }: GlobalSetupContext) {
  if (process.env.TEST_DATABASE_URL?.trim()) return;
  const { backendAvailable, excludePostgres } = decidePostgresTests();
  if (!backendAvailable || excludePostgres) return;

  const user = "shared_test";
  const password = "shared_test";
  const database = "test";
  let container;
  try {
    container = startPostgresTestContainer({ user, password, database });
  } catch (error) {
    console.warn("Could not start shared PostgreSQL test container. Leases will start their own containers.", error);
    return;
  }

  provide("sharedPostgresTestUrl", `postgresql://${user}:${password}@127.0.0.1:${container.port}/${database}`);
  return () => container.stop();
}
