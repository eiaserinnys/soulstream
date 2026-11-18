import { describe, expect, it, vi } from 'vitest';
import { AccessLinksError, createAccessLinksApi, accessLinkStatus } from './access-links-api';

const link = { id: 'a', label: '도우미', target_session_id: '123', permissions: ['send' as const], created_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z', revoked_at: null, last_used_at: null };

describe('access links API', () => {
  it('uses the expected paths, bodies and credentials for list, issue and revoke', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json([link])).mockResolvedValueOnce(Response.json({ ...link, url: 'https://example.test/x/fake' }, { status: 201 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createAccessLinksApi(request);
    expect(await api.list()).toEqual([link]);
    const body = { target_session_id: '123', label: '도우미', permissions: ['send' as const], expires_in_seconds: 86400 };
    expect((await api.issue(body)).url).toBe('https://example.test/x/fake');
    expect(await api.revoke('a/b')).toBeUndefined();
    expect(request).toHaveBeenNthCalledWith(1, '/api/access-links', expect.objectContaining({ credentials: 'same-origin', method: 'GET' }));
    expect(request).toHaveBeenNthCalledWith(2, '/api/access-links', expect.objectContaining({ credentials: 'same-origin', method: 'POST', body: JSON.stringify(body) }));
    expect(request).toHaveBeenNthCalledWith(3, '/api/access-links/a%2Fb', expect.objectContaining({ credentials: 'same-origin', method: 'DELETE' }));
  });
  it('exposes HTTP status without exposing server details', async () => {
    const api = createAccessLinksApi(vi.fn().mockResolvedValue(Response.json({ detail: 'private detail' }, { status: 503 })));
    const error = await api.list().catch(e => e);
    expect(error).toBeInstanceOf(AccessLinksError);
    expect(error.status).toBe(503);
    expect(error.message).not.toContain('private detail');
  });
  it('gives revocation priority over expiry', () => {
    const now = Date.parse('2026-03-01T00:00:00Z');
    expect(accessLinkStatus({ ...link, revoked_at: '2026-01-20T00:00:00Z' }, now)).toBe('revoked');
    expect(accessLinkStatus(link, now)).toBe('expired');
    expect(accessLinkStatus({ ...link, expires_at: '2026-04-01T00:00:00Z' }, now)).toBe('active');
  });
});
