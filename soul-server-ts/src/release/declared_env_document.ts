import { readFile } from "node:fs/promises";

import dotenv from "dotenv";

import type { DeclaredDeploymentEnv } from "./release_env.js";

export interface DeclaredEnvDocument {
  readonly declared: DeclaredDeploymentEnv;
  readonly present: boolean;
}

/**
 * Reads the deployment env document the way the service will read it: dotenv
 * parsing of the declared file, and a missing document contributes an empty map
 * rather than an error (a node without a document keeps the same absence at
 * build, bind, and startup).
 */
export async function readDeclaredEnvDocument(path: string): Promise<DeclaredEnvDocument> {
  try {
    return { declared: dotenv.parse(await readFile(path, "utf8")), present: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { declared: {}, present: false };
  }
}
