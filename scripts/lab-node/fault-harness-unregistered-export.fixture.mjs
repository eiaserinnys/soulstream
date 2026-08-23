export async function ordinaryExportedWiring(target, ...args) {
  return await target(...args);
}
