import { ordinaryExportedWiring } from "./fault-harness-unregistered-export.fixture.mjs";

export async function callOrdinaryWiringAcrossModule(target, ...args) {
  return await ordinaryExportedWiring(target, ...args);
}

export function makeUnregisteredForwardingClosure(target) {
  return async (...args) => {
    const { invokeHarnessBoundary } = await import("./fault-harness-boundary.mjs");
    return await invokeHarnessBoundary(target, ...args);
  };
}
