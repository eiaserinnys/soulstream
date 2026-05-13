"""
Soulstream - 공통 상수 정의

중복 방지를 위해 여러 모듈에서 사용하는 상수를 한 곳에 정의합니다.
"""

# 첨부 파일 최대 크기 (8MB)
MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024

# WS 프레임 수신 한도 — orch가 노드로 WS reverse-proxy 명령(특히
# upload_attachment의 base64 payload)을 push할 때 노드(aiohttp client)의
# `max_msg_size` 기본값 4MB가 8MB attachment(base64 ~10.7MB)를 거부한다.
# MAX_ATTACHMENT_SIZE * 4/3(base64 확장) + 16KB(JSON envelope/keys/metadata 여유)
# 보다 충분히 큰 16MB로 고정한다. 결함 회로: aiohttp `max_msg_size` 기본값과
# 페이로드 크기 부정합 (atom 작업 이력 260513.01 code-review P0).
WS_INCOMING_MAX_MSG_SIZE = 16 * 1024 * 1024

# 위험한 파일 확장자 목록 (민감한 정보가 포함될 수 있는 파일)
DANGEROUS_EXTENSIONS = [
    '.env',
    '.pem',
    '.key',
    '.crt',
    '.p12',
    '.pfx',
    '.jks',
]
