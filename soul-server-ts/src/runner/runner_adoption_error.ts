export interface RunnerReleaseIdentityMismatch {
  runnerManifestId: string;
  runnerRuntimeEnvIdentity: string;
  hostManifestId: string;
  hostRuntimeEnvIdentity: string;
}

/** A live runner belongs to a release this host cannot safely adopt. */
export class RunnerReleaseIdentityMismatchError extends Error {
  readonly runnerManifestId: string;
  readonly runnerRuntimeEnvIdentity: string;
  readonly hostManifestId: string;
  readonly hostRuntimeEnvIdentity: string;

  constructor(identity: RunnerReleaseIdentityMismatch) {
    super(
      "runner adoption release identity mismatch: "
      + `runner manifest=${identity.runnerManifestId} env=${identity.runnerRuntimeEnvIdentity}; `
      + `host manifest=${identity.hostManifestId} env=${identity.hostRuntimeEnvIdentity}`,
    );
    this.name = "RunnerReleaseIdentityMismatchError";
    this.runnerManifestId = identity.runnerManifestId;
    this.runnerRuntimeEnvIdentity = identity.runnerRuntimeEnvIdentity;
    this.hostManifestId = identity.hostManifestId;
    this.hostRuntimeEnvIdentity = identity.hostRuntimeEnvIdentity;
  }
}
