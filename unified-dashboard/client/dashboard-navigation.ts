/** One browser navigation path for routes owned by App, including React state. */
export function navigateDashboard(pathname: string, replace = false) {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', pathname);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
