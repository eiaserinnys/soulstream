import type { ApiRequestContext } from './clientCore';

export interface SessionReviewPolicy {
  key: 'session_review_policy';
  sourceAllowlist: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface SessionReviewSourceCatalogEntry {
  source: string;
  label: string;
  description: string;
  automatic: boolean;
}

export interface SessionReviewPolicyPayload {
  policy: SessionReviewPolicy;
  conditionalRules: Array<{
    source: 'browser';
    label: string;
    description: string;
    condition: 'identified_user';
  }>;
  sourceCatalog: SessionReviewSourceCatalogEntry[];
}

const SESSION_REVIEW_POLICY_PATH =
  '/api/admin/settings/session-review-policy';

export function createSettingsEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    getSessionReviewPolicy: (): Promise<SessionReviewPolicyPayload> =>
      authFetch(`${base}${SESSION_REVIEW_POLICY_PATH}`).then((response) =>
        readJson(response, 'getSessionReviewPolicy'),
      ),

    updateSessionReviewPolicy: (input: {
      sourceAllowlist: string[];
      expectedVersion: number;
    }): Promise<SessionReviewPolicyPayload> =>
      authFetch(`${base}${SESSION_REVIEW_POLICY_PATH}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }).then((response) => readJson(response, 'updateSessionReviewPolicy')),
  };
}
