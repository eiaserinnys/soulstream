"""soul_server.claude package.

import 부수효과로 sdk_patches가 로드되어 claude-agent-sdk Query.initialize를
monkey-patch한다. CLI prompt_suggestion emit 게이트의 SDK 측 키를 활성화.
"""
from . import sdk_patches  # noqa: F401  # monkey-patch 적용 (import 부수효과)
