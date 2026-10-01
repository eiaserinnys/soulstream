export async function checkReviewAuth(request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request('/api/auth/status', {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) return false;
    const status: unknown = await response.json();
    return typeof status === 'object' && status !== null
      && 'authenticated' in status && status.authenticated === true;
  } catch {
    return false;
  }
}
