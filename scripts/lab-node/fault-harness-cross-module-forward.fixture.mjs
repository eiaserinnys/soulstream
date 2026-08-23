import { ordinaryExportedWiring } from "./fault-harness-unregistered-export.fixture.mjs";

export async function callOrdinaryWiringAcrossModule(target, ...args) {
  return await ordinaryExportedWiring(target, ...args);
}
