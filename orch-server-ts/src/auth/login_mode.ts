/**
 * Singular decision point for which dashboard login a deployment offers.
 *
 * The order is the product contract: an explicit Google OAuth deployment wins,
 * then installer password login, then the historical no-login dashboard.
 * A future mode (for example Tailscale) slots into this chain instead of
 * introducing another independent gate.
 */

export type DashboardLoginMode = "google" | "password" | "none";

export type DashboardLoginModeConfig = {
  readonly google_client_id?: string;
  readonly dashboard_admin_password?: string;
};

export function resolveDashboardLoginMode(
  config: DashboardLoginModeConfig,
): DashboardLoginMode {
  if ((config.google_client_id ?? "").length > 0) return "google";
  if ((config.dashboard_admin_password ?? "").length > 0) return "password";
  return "none";
}

/** Dashboard login is enforced whenever any login mode is configured. */
export function dashboardAuthEnabled(config: DashboardLoginModeConfig): boolean {
  return resolveDashboardLoginMode(config) !== "none";
}
