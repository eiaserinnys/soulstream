import type { AccessLink, AccessLinkIssue } from '../lib/access-links-api';

const names = ['✨ 서소영 관제', '🌿 로젤린 작업', '🔍 조사 세션', '📝 글쓰기', '🎨 디자인 검수', '🧭 프로젝트 안내', '📚 자료 정리', '🤖 긴 이름을 가진 영구 에이전트 세션'];
export const accessLinkSessions = names.map((display_name, index) => ({
  session_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  display_name, agent_name: '로젤린',
}));
export function createAccessLinksFixture() {
  const now = Date.now();
  const day = 86400000;
  let links: AccessLink[] = ['외부 조사 도우미', '요약을 맡기는 에이전트', '긴 발신자 이름 '.repeat(10).slice(0, 80), '지난 연결'].map((label, index) => ({
    id: `link-${index}`, label, target_session_id: accessLinkSessions[index]!.session_id,
    permissions: index === 1 ? ['send', 'read_own', 'read_history'] : ['send', 'read_own'],
    created_at: new Date(now - (index + 1) * day).toISOString(), expires_at: new Date(now + (index === 3 ? -day : 7 * day)).toISOString(),
    revoked_at: null, last_used_at: index === 0 ? new Date(now - 3 * 60000).toISOString() : null,
  }));
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'https://sample.invalid').pathname;
    if (path === '/api/persistent-sessions') return Response.json({ sessions: accessLinkSessions, total: accessLinkSessions.length });
    if (init?.method === 'POST') {
      const issue = JSON.parse(String(init.body)) as AccessLinkIssue;
      const link: AccessLink = { id: `link-${links.length}`, ...issue, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + issue.expires_in_seconds * 1000).toISOString(), revoked_at: null, last_used_at: null };
      links = [link, ...links];
      return Response.json({ ...link, url: 'https://example.test/x/fake-review-key' }, { status: 201 });
    }
    if (init?.method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop()!);
      const link = links.find(item => item.id === id);
      if (!link) return Response.json({ detail: 'Not found' }, { status: 404 });
      link.revoked_at = new Date().toISOString();
      return Response.json(link);
    }
    return Response.json(links);
  };
}
