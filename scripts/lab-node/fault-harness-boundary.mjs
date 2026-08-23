import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The single construction path for verdict-critical cross-module wiring.
 *
 * A boundary is executable production wiring and its adversarial proof in one
 * value. There is no second inventory to update: constructing the callable
 * registers its contract, and construction without a proof is rejected.
 */
const registry = new Map();
const registeredBoundaries = new WeakMap();
const registeredInvokers = new WeakMap();
const execution = new AsyncLocalStorage();

export function defineHarnessBoundary(definition) {
  const { name, what, implementation, contract } = definition ?? {};
  requireText(name, "boundary name");
  requireText(what, `boundary ${name} description`);
  if (typeof implementation !== "function") {
    throw new TypeError(`boundary ${name} requires an implementation`);
  }
  if (typeof contract !== "function") {
    throw new TypeError(`boundary ${name} requires an inline contract`);
  }
  if (registry.has(name)) throw new Error(`duplicate harness boundary: ${name}`);

  const boundary = async (...args) => {
    const proof = registeredBoundaries.get(boundary);
    if (!proof || registry.get(name) !== proof || execution.getStore() !== boundary) {
      throw new Error(
        `harness boundary ${name} must be invoked through the registered boundary runtime`,
      );
    }
    return await implementation(...args);
  };
  let contractInvoker;
  const proof = Object.freeze({
    name,
    what,
    check: async () => await contract(contractInvoker),
  });
  Object.defineProperty(boundary, "boundaryContract", {
    value: proof,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  registry.set(name, proof);
  registeredBoundaries.set(boundary, proof);
  contractInvoker = bindHarnessBoundary(boundary);
  return Object.freeze(boundary);
}

/**
 * Creates the only callable that may ask the public runtime to execute a
 * registered boundary. The binding is a transparent pass-through: wiring
 * that transforms arguments or results remains a boundary of its own and
 * therefore still needs an inline contract.
 */
export function bindHarnessBoundary(boundary) {
  const proof = typeof boundary === "function"
    ? registeredBoundaries.get(boundary)
    : undefined;
  if (!proof || registry.get(proof.name) !== proof || boundary.boundaryContract !== proof) {
    throw new Error("cannot bind unregistered harness wiring");
  }
  const invoker = async (...args) => await invokeHarnessBoundary(invoker, ...args);
  Object.defineProperty(invoker, "boundaryContract", {
    value: proof,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  registeredInvokers.set(invoker, Object.freeze({ boundary, proof }));
  return Object.freeze(invoker);
}

export async function invokeHarnessBoundary(invoker, ...args) {
  const registration = typeof invoker === "function"
    ? registeredInvokers.get(invoker)
    : undefined;
  const { boundary, proof } = registration ?? {};
  if (!registration
    || registry.get(proof.name) !== proof
    || invoker.boundaryContract !== proof
    || registeredBoundaries.get(boundary) !== proof
    || boundary.boundaryContract !== proof) {
    throw new Error("unregistered harness invoker cannot execute");
  }
  return await execution.run(boundary, async () => await boundary(...args));
}

export function registeredBoundaryContracts() {
  return Object.freeze([...registry.values()]);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
