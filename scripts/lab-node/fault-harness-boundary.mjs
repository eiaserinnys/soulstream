/**
 * The single construction path for verdict-critical cross-module wiring.
 *
 * A boundary is executable production wiring and its adversarial proof in one
 * value. There is no second inventory to update: constructing the callable
 * registers its contract, and construction without a proof is rejected.
 */
const registry = new Map();

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

  const boundary = async (...args) => await implementation(...args);
  const proof = Object.freeze({
    name,
    what,
    check: async () => await contract(boundary),
  });
  Object.defineProperty(boundary, "boundaryContract", {
    value: proof,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  registry.set(name, proof);
  return Object.freeze(boundary);
}

export function registeredBoundaryContracts() {
  return Object.freeze([...registry.values()]);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
