"""웹훅 탭 시각 검수의 견본 자료와 API 가로채기."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

SESSIONS = [
    {'session_id': f'00000000-0000-4000-8000-{i + 1:012}', 'display_name': name, 'agent_name': '로젤린'}
    for i, name in enumerate(['✨ 서소영 관제', '🌿 로젤린 작업', '🔍 조사 세션', '📝 글쓰기', '🎨 디자인 검수', '🧭 프로젝트 안내', '📚 자료 정리', '🤖 아주 긴 영구 에이전트 세션 이름'])
]
LONG_SENDER = ('아주 긴 이름을 가진 외부 수집 서비스 ' * 6)[:80]
FAKE_KEY = 'fake-inbound-secret-' + 'F' * 20
FAKE_SIGNING = 'whsec_fake_' + 'G' * 32


def iso(days: float = 0, minutes: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days, minutes=minutes)).isoformat()


def new_inbound():
    return [
        {'id': 'inbound-mail', 'label': 'n8n 메일 요약', 'target_session_id': SESSIONS[0]['session_id'], 'auth_mode': 'key', 'preamble': None,
         'url': 'https://soulstream.example.test/api/webhooks/inbound/inbound-mail/' + 'A' * 20,
         'created_at': iso(-5), 'expires_at': None, 'revoked_at': None, 'last_used_at': iso(0, -3), 'state': 'active',
         'recent': {'count_24h': 12, 'failed_24h': 2, 'last_received_at': iso(0, -3)}},
        {'id': 'inbound-long', 'label': LONG_SENDER, 'target_session_id': SESSIONS[7]['session_id'], 'auth_mode': 'signature', 'preamble': '자료로 다루십시오.',
         'url': 'https://soulstream.example.test/api/webhooks/inbound/inbound-long/' + 'B' * 20,
         'created_at': iso(-30), 'expires_at': iso(335), 'revoked_at': None, 'last_used_at': None, 'state': 'active',
         'recent': {'count_24h': 0, 'failed_24h': 0, 'last_received_at': None}},
        {'id': 'inbound-expired', 'label': '지난 수집 웹훅', 'target_session_id': SESSIONS[2]['session_id'], 'auth_mode': 'key', 'preamble': None,
         'url': 'https://soulstream.example.test/api/webhooks/inbound/inbound-expired/' + 'C' * 20,
         'created_at': iso(-40), 'expires_at': iso(-1), 'revoked_at': None, 'last_used_at': iso(-2), 'state': 'expired',
         'recent': {'count_24h': 0, 'failed_24h': 0, 'last_received_at': iso(-2)}},
        {'id': 'inbound-revoked', 'label': '옛 조사 웹훅', 'target_session_id': SESSIONS[3]['session_id'], 'auth_mode': 'key', 'preamble': None,
         'url': 'https://soulstream.example.test/api/webhooks/inbound/inbound-revoked/' + 'D' * 20,
         'created_at': iso(-20), 'expires_at': None, 'revoked_at': iso(-3), 'last_used_at': iso(-4), 'state': 'revoked',
         'recent': {'count_24h': 0, 'failed_24h': 0, 'last_received_at': iso(-4)}},
    ]


def new_requests():
    return [
        {'request_id': 'req-5f2a9c1e-1111-4a11-9e33-0d0f2c7d9a01', 'status': 'accepted', 'session': {'state': 'idle'}, 'received_at': iso(0, -4)},
        {'request_id': 'req-5f2a9c1e-2222-4a11-9e33-0d0f2c7d9a02', 'status': 'processing', 'session': {'state': 'running'}, 'received_at': iso(0, -18)},
        {'request_id': 'req-5f2a9c1e-3333-4a11-9e33-0d0f2c7d9a03', 'status': 'processing', 'session': {'state': 'stopped'}, 'received_at': iso(0, -95)},
        {'request_id': 'req-5f2a9c1e-4444-4a11-9e33-0d0f2c7d9a04', 'status': 'completed', 'session': {'state': 'idle'}, 'received_at': iso(-1)},
        {'request_id': 'req-5f2a9c1e-5555-4a11-9e33-0d0f2c7d9a05', 'status': 'failed', 'session': {'state': 'error'}, 'received_at': iso(-2)},
    ]


def new_outbound():
    return [
        {'id': 'outbound-summary', 'label': '요약 받는 주소', 'target_session_id': SESSIONS[1]['session_id'],
         'event_types': ['session.reply', 'session.question', 'session.failed'], 'url': 'https://push.example.net/hooks/summary/monthly',
         'active': True, 'disabled_reason': None, 'consecutive_failures': 0, 'created_at': iso(-8), 'updated_at': iso(0, -60), 'recent_failures': 1},
        {'id': 'outbound-team', 'label': '팀 알림', 'target_session_id': SESSIONS[4]['session_id'],
         'event_types': ['session.failed', 'session.ended'], 'url': 'https://team.example.org/incoming/soulstream',
         'active': True, 'disabled_reason': None, 'consecutive_failures': 0, 'created_at': iso(-8), 'updated_at': iso(0, -60), 'recent_failures': 0},
        {'id': 'outbound-off', 'label': '꺼진 수집기', 'target_session_id': SESSIONS[5]['session_id'],
         'event_types': ['session.reply'], 'url': 'https://old.example.net/collect',
         'active': False, 'disabled_reason': 'consecutive_failures', 'consecutive_failures': 20, 'created_at': iso(-8), 'updated_at': iso(0, -60), 'recent_failures': 20},
    ]


def new_deliveries():
    return {
        'outbound-summary': [
            {'id': 'delivery-1', 'event_id': 101, 'event_type': 'session.reply', 'state': 'delivered', 'attempt_count': 0, 'next_attempt_at': iso(0, -20), 'last_status': 200, 'last_error': None, 'created_at': iso(0, -20), 'delivered_at': iso(0, -20)},
            {'id': 'delivery-2', 'event_id': 102, 'event_type': 'session.question', 'state': 'pending', 'attempt_count': 2, 'next_attempt_at': iso(0, 20), 'last_status': 503, 'last_error': None, 'created_at': iso(0, -10), 'delivered_at': None},
            {'id': 'delivery-3', 'event_id': 103, 'event_type': 'session.failed', 'state': 'dead', 'attempt_count': 3, 'next_attempt_at': iso(0, -5), 'last_status': 503, 'last_error': None, 'created_at': iso(0, -60), 'delivered_at': None},
            {'id': 'delivery-4', 'event_id': 104, 'event_type': 'session.reply', 'state': 'dead', 'attempt_count': 0, 'next_attempt_at': iso(0, -30), 'last_status': None, 'last_error': 'timeout', 'created_at': iso(0, -90), 'delivered_at': None},
        ],
        'outbound-team': [
            {'id': 'delivery-5', 'event_id': 105, 'event_type': 'session.ended', 'state': 'delivered', 'attempt_count': 0, 'next_attempt_at': iso(0, -40), 'last_status': 204, 'last_error': None, 'created_at': iso(0, -40), 'delivered_at': iso(0, -40)},
        ],
        'outbound-off': [
            {'id': 'delivery-6', 'event_id': 106, 'event_type': 'session.reply', 'state': 'dead', 'attempt_count': 0, 'next_attempt_at': iso(0, -120), 'last_status': None, 'last_error': 'disabled_while_pending', 'created_at': iso(0, -200), 'delivered_at': None},
        ],
    }


def initial_state():
    return {
        'inbound': new_inbound(), 'outbound': new_outbound(), 'requests': new_requests(), 'deliveries': new_deliveries(),
        'inboundList': 'normal', 'outboundList': 'normal', 'requestsState': 'normal', 'deliveriesState': 'normal', 'pas': 'ok',
        'inboundIssue': 201, 'keyUrl': False, 'outboundCreate': 201, 'challengeReason': 'timeout',
        'revoke': 200, 'patch': 200, 'delete': 204, 'redeliver': 'delivered', 'slowWrite': False,
    }


def make_route(state):
    def route_api(route):
        request = route.request
        url = request.url
        path = urlparse(url).path
        query = parse_qs(urlparse(url).query)
        method = request.method

        def fail(status=503, payload=None):
            route.fulfill(status=status, json=payload or {'detail': 'fixture failure'})

        def sub(item_id):
            return next((entry for entry in state['outbound'] if entry['id'] == item_id), None)

        if path.endswith('/api/persistent-sessions'):
            if state['pas'] == 'error':
                return fail(503)
            return route.fulfill(json={'sessions': SESSIONS, 'total': len(SESSIONS)})
        if path == '/api/webhooks/inbound':
            if method == 'POST':
                if state['inboundIssue'] != 201:
                    return fail(state['inboundIssue'])
                body = request.post_data_json
                item = {
                    'id': 'inbound-created', 'label': body['label'], 'target_session_id': body['target_session_id'],
                    'auth_mode': body['auth_mode'], 'preamble': body.get('preamble'),
                    'url': 'https://soulstream.example.test/api/webhooks/inbound/inbound-created/' + 'E' * 20,
                    'created_at': iso(0), 'expires_at': iso(body['expires_in_seconds'] / 86400) if body.get('expires_in_seconds') else None,
                    'revoked_at': None, 'last_used_at': None, 'state': 'active',
                    'recent': {'count_24h': 0, 'failed_24h': 0, 'last_received_at': None},
                }
                state['inbound'] = [item] + [entry for entry in state['inbound'] if entry['id'] != 'inbound-created']
                payload = {**item, 'secret': FAKE_KEY}
                if state['keyUrl']:
                    payload['key_url'] = 'https://soulstream.example.test/x/fake-key/one'
                return route.fulfill(status=201, json=payload)
            if state['inboundList'] == 'error':
                return fail(503)
            if state['inboundList'] == 'empty':
                return route.fulfill(json=[])
            return route.fulfill(json=state['inbound'])
        if path.startswith('/api/webhooks/inbound/') and path.endswith('/requests'):
            if state['requestsState'] == 'error':
                return fail(503)
            if state['requestsState'] == 'empty':
                return route.fulfill(json={'items': []})
            return route.fulfill(json={'items': state['requests']})
        if path.startswith('/api/webhooks/inbound/') and method == 'DELETE':
            if state['revoke'] != 200:
                return fail(state['revoke'])
            item_id = path.rsplit('/', 1)[-1]
            entry = next((item for item in state['inbound'] if item['id'] == item_id), None)
            if entry is None:
                return fail(404)
            entry['state'] = 'revoked'
            entry['revoked_at'] = iso(0)
            return route.fulfill(json=entry)
        if path == '/api/webhooks/outbound':
            if method == 'POST':
                if state['outboundCreate'] == 422:
                    return route.fulfill(status=422, json={'error': 'challenge_failed', 'reason': state['challengeReason']})
                if state['outboundCreate'] != 201:
                    return route.fulfill(status=state['outboundCreate'], json={'error': 'forbidden' if state['outboundCreate'] == 403 else 'session_not_found'})
                body = request.post_data_json
                item = {
                    'id': 'outbound-created', 'label': body['label'], 'target_session_id': body['target_session_id'],
                    'event_types': body['event_types'], 'url': body['url'], 'active': True, 'disabled_reason': None,
                    'consecutive_failures': 0, 'created_at': iso(0), 'updated_at': iso(0), 'recent_failures': 0,
                }
                state['outbound'] = [item] + [entry for entry in state['outbound'] if entry['id'] != 'outbound-created']
                state['deliveries']['outbound-created'] = []
                return route.fulfill(status=201, json={'subscription': item, 'signing_secret': FAKE_SIGNING})
            if state['outboundList'] == 'error':
                return fail(503)
            if state['outboundList'] == 'empty':
                return route.fulfill(json={'subscriptions': []})
            return route.fulfill(json={'subscriptions': state['outbound']})
        if path.startswith('/api/webhooks/outbound/') and path.endswith('/redeliver'):
            parts = path.split('/')
            item = sub(parts[4])
            if item is None:
                return fail(404)
            if not item['active']:
                return route.fulfill(status=409, json={'error': 'subscription_inactive'})
            if state['redeliver'] == '409':
                return route.fulfill(status=409, json={'error': 'subscription_inactive'})
            if state['redeliver'] in ('delivered', 'dead', 'skipped', 'retrying'):
                delivery_id = parts[6]
                delivery = next((entry for entry in state['deliveries'].get(item['id'], []) if entry['id'] == delivery_id), None)
                if delivery is None or delivery['state'] != 'dead':
                    return route.fulfill(json={'outcome': 'skipped'})
                if state['redeliver'] == 'delivered':
                    delivery.update({'state': 'delivered', 'last_status': 200, 'last_error': None, 'delivered_at': iso(0)})
                if state['redeliver'] == 'retrying':
                    delivery.update({'state': 'pending', 'next_attempt_at': iso(0, 20)})
                return route.fulfill(json={'outcome': state['redeliver']})
            return route.fulfill(json={'outcome': state['redeliver']})
        if path.startswith('/api/webhooks/outbound/') and path.endswith('/deliveries'):
            if state['deliveriesState'] == 'error':
                return fail(503)
            item_id = path.split('/')[4]
            rows = state['deliveries'].get(item_id, [])
            wanted = query.get('state', [None])[0]
            rows = [entry for entry in rows if wanted is None or entry['state'] == wanted]
            return route.fulfill(json={'deliveries': rows})
        if path.startswith('/api/webhooks/outbound/'):
            item_id = path.rsplit('/', 1)[-1]
            item = sub(item_id)
            if method == 'PATCH':
                if state['patch'] != 200:
                    return fail(state['patch'])
                body = request.post_data_json
                item['active'] = bool(body['active'])
                item['disabled_reason'] = None if item['active'] else 'user_disabled'
                item['consecutive_failures'] = 0 if item['active'] else item['consecutive_failures']
                if not item['active']:
                    for delivery in state['deliveries'].get(item_id, []):
                        if delivery['state'] == 'pending':
                            delivery.update({'state': 'dead', 'last_error': 'disabled_while_pending'})
                return route.fulfill(json={'subscription': item})
            if method == 'DELETE':
                if state['delete'] != 204:
                    return fail(state['delete'])
                state['outbound'] = [entry for entry in state['outbound'] if entry['id'] != item_id]
                state['deliveries'].pop(item_id, None)
                return route.fulfill(status=204)
        return fail(404)

    return route_api
