import { randomUUID } from "node:crypto";

import type { ReleaseManifestV1 } from "./release_manifest.js";

export type ReleaseVerificationResult = {
  host: "verified";
  runner: "verified";
  env: "verified";
  executable: "verified";
};

export interface ReleaseActivationRegistration {
  manifest_id: string;
  release_cohort_id: string;
  source_commit: string;
  prewarmed_at: string;
  verification: ReleaseVerificationResult;
  registration_idempotency_key: string;
}

export interface ReleaseActivationReceipt {
  manifest_id: string;
  activation_generation: number;
  activated_at: string;
  registration_idempotency_key: string;
}

export class ReleaseActivationState {
  private readonly now: () => Date;
  private readonly registrationIdempotencyKey: string;
  private prewarmed: ReleaseActivationRegistration | undefined;
  private receipt: ReleaseActivationReceipt | undefined;

  constructor(
    readonly manifest: ReleaseManifestV1,
    options: {
      now?: () => Date;
      registrationIdempotencyKey?: string;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registrationIdempotencyKey = options.registrationIdempotencyKey ?? randomUUID();
  }

  markPrewarmed(verification: ReleaseVerificationResult): void {
    this.prewarmed ??= {
      manifest_id: this.manifest.manifest_id,
      release_cohort_id: this.manifest.release_cohort_id,
      source_commit: this.manifest.source_commit,
      prewarmed_at: this.now().toISOString(),
      verification,
      registration_idempotency_key: this.registrationIdempotencyKey,
    };
  }

  registration(): ReleaseActivationRegistration {
    if (!this.prewarmed) throw new Error("release activation registration requested before prewarm");
    return this.prewarmed;
  }

  acceptReceipt(receipt: ReleaseActivationReceipt): void {
    if (!this.prewarmed) throw new Error("activation receipt received before prewarm");
    if (receipt.manifest_id !== this.manifest.manifest_id) {
      throw new Error("activation receipt manifest mismatch");
    }
    if (receipt.registration_idempotency_key !== this.registrationIdempotencyKey) {
      throw new Error("activation receipt registration key mismatch");
    }
    if (!Number.isSafeInteger(receipt.activation_generation) || receipt.activation_generation <= 0) {
      throw new Error("activation receipt generation invalid");
    }
    if (!Number.isFinite(Date.parse(receipt.activated_at))) {
      throw new Error("activation receipt timestamp invalid");
    }
    if (this.receipt && (
      this.receipt.activation_generation !== receipt.activation_generation
      || this.receipt.activated_at !== receipt.activated_at
    )) {
      throw new Error("activation receipt changed for one registration key");
    }
    this.receipt = receipt;
  }

  isReady(): boolean {
    return this.receipt !== undefined;
  }

  health(): Record<string, unknown> {
    const ready = this.isReady();
    return {
      status: ready ? "ok" : "starting",
      ready,
      manifest_id: this.manifest.manifest_id,
      release_cohort_id: this.manifest.release_cohort_id,
      source_commit: this.manifest.source_commit,
      prewarmed_at: this.prewarmed?.prewarmed_at ?? null,
      activation_generation: this.receipt?.activation_generation ?? null,
      activated_at: this.receipt?.activated_at ?? null,
    };
  }
}
