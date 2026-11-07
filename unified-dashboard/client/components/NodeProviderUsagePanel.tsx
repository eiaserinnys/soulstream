import { useCallback, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { ProviderUsageChart, type ProviderName, type ProviderUsageSnapshot } from "./ProviderUsageChart";

interface Props {
  nodeId: string;
  request: typeof fetch;
  providers: readonly ProviderName[];
}

export function NodeProviderUsagePanel({ nodeId, request, providers }: Props) {
  const [providerUsage, setProviderUsage] = useState<ProviderUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProviderUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request(`/api/nodes/${nodeId}/provider-usage`);
      if (!res.ok) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }
      setProviderUsage((await res.json()) as ProviderUsageSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [nodeId, request]);

  return (
    <div className="border-t border-border px-3 py-3">
      <section className="c724-pool-section" data-testid="node-provider-usage-panel">
        <div className="c724-pool-header">
          <div className="c724-pool-title-group">
            <span className="c724-pool-title">다른 공급자</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchProviderUsage}
            disabled={loading}
          >
            {loading ? "..." : "사용량"}
          </Button>
        </div>
        {providerUsage && <ProviderUsageChart usage={providerUsage} providers={providers} />}
        {error && <p className="c724-pool-error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
