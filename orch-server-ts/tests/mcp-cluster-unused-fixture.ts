import type { McpHostOptions } from "../src/mcp/types.js";

const unused = new Proxy({}, { get() { throw new Error("Cluster dependency not used by this fixture"); } });
export const unusedClusterDependencies = {
  recurringJobs: unused as McpHostOptions["recurringJobs"],
  cardOrchestration: unused as McpHostOptions["cardOrchestration"],
  cluster: unused as McpHostOptions["cluster"],
};
