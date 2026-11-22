/**
 * Singular decision point for which dashboard login a deployment offers.
 *
 * The order is the product contract: an explicit Google OAuth deployment wins,
 * then Tailscale Serve identity, installer password login, and the historical
 * no-login dashboard.
 */

export type DashboardLoginMode = "google" | "tailscale" | "password" | "none";

export type DashboardLoginModeConfig = {
  readonly google_client_id?: string;
  readonly dashboard_admin_password?: string;
  readonly tailscale_auth_enabled?: boolean;
};

export function resolveDashboardLoginMode(
  config: DashboardLoginModeConfig,
): DashboardLoginMode {
  if ((config.google_client_id ?? "").length > 0) return "google";
  if (config.tailscale_auth_enabled) return "tailscale";
  if ((config.dashboard_admin_password ?? "").length > 0) return "password";
  return "none";
}

/** Dashboard login is enforced whenever any login mode is configured. */
export function dashboardAuthEnabled(config: DashboardLoginModeConfig): boolean {
  return resolveDashboardLoginMode(config) !== "none";
}
